import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePostgresAccountDeletionReplayReceipt } from
  "../src/lib/postgres-account-deletion-replay.js";
import { parsePostgresLogicalBackupManifest } from
  "../src/lib/postgres-logical-restore.js";
import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import { postgresPrivateStorageRecoveryInternals } from
  "../src/lib/postgres-private-storage-recovery.js";
import {
  productionRecoveryLogicalOffsiteResultSchema,
  productionRecoveryLogicalOffsiteRetrievalSchema,
  productionRecoveryLogicalRestoreReceiptSchema,
  productionRecoveryLogicalWormResultSchema as logicalWormResultSchema,
  productionRecoveryLogicalWormRetrievalSchema as logicalWormRetrievalSchema,
  productionRecoveryPitrReceiptSchema,
  productionRecoveryPrivateCaptureSchema,
  productionRecoveryPrivateRestoreSchema,
  productionRecoveryPrivateWormResultSchema as privateWormResultSchema,
  productionRecoveryPrivateWormRetrievalSchema as privateWormRetrievalSchema,
  productionRecoveryRailwayTeardownTerminalSchema as railwayTerminalSchema,
  productionRecoveryRecoveredApplicationSchema,
  productionRecoveryStoragePurgeReceiptSchema as storagePurgeReceiptSchema,
  productionRecoverySupabaseTeardownTerminalSchema as supabaseTerminalSchema,
} from "../src/lib/production-promotion-recovery.js";

import {
  holdPrivateDirectoryIdentity,
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVIDENCE_BYTES = 128 * 1024 * 1024;

export const PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_EVIDENCE = Object.freeze([
  "deletion-replay-first-receipt.json",
  "deletion-replay-second-receipt.json",
  "logical-backup-manifest.json",
  "logical-offsite-result.json",
  "logical-restore-receipt.json",
  "logical-worm-result.json",
  "logical-worm-retrieval-receipt.json",
  "offsite-retrieval-receipt.json",
  "pitr-receipt.json",
  "private-storage-capture-receipt.json",
  "private-storage-recovery-manifest.json",
  "private-storage-restore-receipt.json",
  "private-storage-worm-receipt.json",
  "private-storage-worm-retrieval-receipt.json",
  "recovered-smoke-receipt.json",
  "storage-purge-receipt.json",
  "railway-teardown-terminal.json",
  "supabase-teardown-terminal.json",
]);

export const PRODUCTION_PROMOTION_RECOVERY_CLEANUP_EVIDENCE = Object.freeze([
  "railway-teardown-terminal.json",
  "storage-purge-receipt.json",
  "supabase-teardown-terminal.json",
]);

export const PRODUCTION_PROMOTION_RECOVERY_EXACT_SCHEMA_EVIDENCE = Object.freeze([
  "deletion-replay-first-receipt.json",
  "deletion-replay-second-receipt.json",
  "logical-backup-manifest.json",
  "logical-offsite-result.json",
  "logical-restore-receipt.json",
  "logical-worm-result.json",
  "logical-worm-retrieval-receipt.json",
  "offsite-retrieval-receipt.json",
  "pitr-receipt.json",
  "private-storage-capture-receipt.json",
  "private-storage-recovery-manifest.json",
  "private-storage-restore-receipt.json",
  "private-storage-worm-receipt.json",
  "private-storage-worm-retrieval-receipt.json",
  "recovered-smoke-receipt.json",
  "storage-purge-receipt.json",
  "railway-teardown-terminal.json",
  "supabase-teardown-terminal.json",
]);

function fail(code) {
  throw new Error(`production_promotion_recovery_activation_receipt_${code}`);
}

function parseArgs(argv) {
  if (argv.length !== 18) fail("arguments_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) fail("arguments_invalid");
    values.set(key, value);
  }
  const input = {
    directory: values.get("--directory") ?? "",
    candidateSha: values.get("--candidate-sha") ?? "",
    runId: values.get("--run-id") ?? "",
    runAttempt: values.get("--run-attempt") ?? "",
    targetProjectId: values.get("--target-project-id") ?? "",
    targetEnvironmentId: values.get("--target-environment-id") ?? "",
    targetDatabaseIdentitySha256: values.get("--target-database-identity-sha256") ?? "",
    targetSupabaseOriginSha256: values.get("--target-supabase-origin-sha256") ?? "",
    output: values.get("--output") ?? "",
  };
  if (values.size !== 9 || !path.isAbsolute(input.directory)
    || path.resolve(input.directory) !== input.directory || input.directory.includes("\0")
    || !path.isAbsolute(input.output) || path.resolve(input.output) !== input.output
    || input.output.includes("\0") || path.dirname(input.output) !== input.directory
    || path.basename(input.output) !== "activation-receipt.json"
    || !SHA.test(input.candidateSha) || !RUN_ID.test(input.runId)
    || input.runAttempt !== "1" || !UUID.test(input.targetProjectId)
    || !UUID.test(input.targetEnvironmentId)
    || !SHA256.test(input.targetDatabaseIdentitySha256)
    || !SHA256.test(input.targetSupabaseOriginSha256)) fail("arguments_invalid");
  return input;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
  }
  fail("canonicalization_failed");
}

export function canonicalProductionPromotionRecoveryActivationJson(value) {
  return `${canonicalize(value)}\n`;
}

function canonicalHash(value) {
  return hash(canonicalProductionPromotionRecoveryActivationJson(value));
}

function parseEvidence(schema, value, code) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(code);
  return parsed.data;
}

function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function exactTimestamp(value, code) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(code);
  return value;
}

function parseJson(file, code) {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    const value = object(JSON.parse(source), code);
    if (canonicalPostgresBackupJson(value) !== source) fail(code);
    return value;
  } catch {
    return fail(code);
  }
}

function verifyReplay(first, second, input, files) {
  try {
    first = parsePostgresAccountDeletionReplayReceipt(first);
    second = parsePostgresAccountDeletionReplayReceipt(second);
  } catch {
    fail("replay_invalid");
  }
  const firstCounts = object(first.counts, "replay_invalid");
  const secondCounts = object(second.counts, "replay_invalid");
  let backupManifest, recoveryManifest;
  try {
    backupManifest = parsePostgresLogicalBackupManifest(
      files["logical-backup-manifest.json"].bytes,
    );
    recoveryManifest = postgresPrivateStorageRecoveryInternals.parseRecoveryManifest(
      files["private-storage-recovery-manifest.json"].bytes,
    );
  } catch {
    fail("replay_invalid");
  }
  const logicalRestore = parseEvidence(productionRecoveryLogicalRestoreReceiptSchema,
    parseJson(files["logical-restore-receipt.json"], "replay_invalid"), "replay_invalid");
  const tombstones = first.ledgerTombstoneCount;
  if (first.kind !== "pintpath-postgres-account-deletion-tombstone-replay"
    || second.kind !== first.kind || first.version !== 2 || second.version !== 2
    || first.status !== "verified" || second.status !== "verified"
    || first.migrationCandidateSha !== input.candidateSha
    || second.migrationCandidateSha !== input.candidateSha
    || first.targetIdentitySha256 !== input.targetDatabaseIdentitySha256
    || second.targetIdentitySha256 !== input.targetDatabaseIdentitySha256
    || first.targetIdentitySha256 !== logicalRestore.targetIdentitySha256
    || first.baseRestoreReceiptSha256 !== files["logical-restore-receipt.json"].sha256
    || second.baseRestoreReceiptSha256 !== files["logical-restore-receipt.json"].sha256
    || first.backupManifestSha256 !== files["logical-backup-manifest.json"].sha256
    || second.backupManifestSha256 !== files["logical-backup-manifest.json"].sha256
    || first.backupArchiveSha256 !== backupManifest.archive.sha256
    || second.backupArchiveSha256 !== backupManifest.archive.sha256
    || first.sourceStateReceiptSha256 !== backupManifest.state.receiptSha256
    || second.sourceStateReceiptSha256 !== backupManifest.state.receiptSha256
    || first.sourceSnapshotBindingSha256 !== backupManifest.state.snapshotBindingSha256
    || second.sourceSnapshotBindingSha256 !== backupManifest.state.snapshotBindingSha256
    || first.expectedSourceOverallStateSha256 !== backupManifest.state.overallStateSha256
    || second.expectedSourceOverallStateSha256 !== backupManifest.state.overallStateSha256
    || first.restoredOverallStateSha256 !== logicalRestore.restoredOverallStateSha256
    || second.restoredOverallStateSha256 !== logicalRestore.restoredOverallStateSha256
    || first.migrationRunSha256 !== recoveryManifest.logicalBackup.migrationRunSha256
    || second.migrationRunSha256 !== recoveryManifest.logicalBackup.migrationRunSha256
    || first.ledgerCurrentSha256 !== recoveryManifest.deletionAuthority.currentSha256
    || second.ledgerCurrentSha256 !== recoveryManifest.deletionAuthority.currentSha256
    || first.ledgerGenesisSha256 !== recoveryManifest.deletionAuthority.genesisSha256
    || second.ledgerGenesisSha256 !== recoveryManifest.deletionAuthority.genesisSha256
    || first.ledgerCheckpointSha256 !== recoveryManifest.deletionAuthority.checkpointSha256
    || second.ledgerCheckpointSha256 !== recoveryManifest.deletionAuthority.checkpointSha256
    || first.ledgerImmutableSetSha256 !== recoveryManifest.deletionAuthority.immutableSetSha256
    || second.ledgerImmutableSetSha256 !== recoveryManifest.deletionAuthority.immutableSetSha256
    || first.targetClass !== "disposable-rehearsal"
    || second.targetClass !== "disposable-rehearsal"
    || first.replayEffectiveRole !== "pintpath_maintenance"
    || second.replayEffectiveRole !== "pintpath_maintenance"
    || first.replayRoleRestricted !== true || second.replayRoleRestricted !== true
    || first.transportProfile !== "railway-stock-localhost-ca-v1"
    || second.transportProfile !== "railway-stock-localhost-ca-v1"
    || !Number.isSafeInteger(tombstones) || tombstones < 1
    || second.ledgerTombstoneCount !== tombstones
    || firstCounts.seen !== tombstones || firstCounts.newlyApplied !== tombstones
    || firstCounts.alreadyApplied !== 0 || firstCounts.missing !== 0 || firstCounts.failed !== 0
    || secondCounts.seen !== tombstones || secondCounts.newlyApplied !== 0
    || secondCounts.alreadyApplied !== tombstones
    || secondCounts.missing !== 0 || secondCounts.failed !== 0
    || first.semanticProjectionSha256 !== second.semanticProjectionSha256
    || first.ledgerCurrentSha256 !== second.ledgerCurrentSha256
    || first.idempotency !== "exact-semantic-projection"
    || second.idempotency !== "exact-semantic-projection") fail("replay_invalid");
  const firstAt = exactTimestamp(first.replayedAt, "replay_invalid");
  const secondAt = exactTimestamp(second.replayedAt, "replay_invalid");
  if (Date.parse(secondAt) <= Date.parse(firstAt)) fail("replay_invalid");
}

function verifyRecoveryBundle(files, input) {
  let backupManifest;
  try {
    backupManifest = parsePostgresLogicalBackupManifest(
      files["logical-backup-manifest.json"].bytes,
    );
  } catch {
    fail("manifest_invalid");
  }
  const capture = parseEvidence(productionRecoveryPrivateCaptureSchema,
    parseJson(files["private-storage-capture-receipt.json"], "capture_invalid"),
    "capture_invalid");
  let manifest;
  try {
    manifest = postgresPrivateStorageRecoveryInternals.parseRecoveryManifest(
      files["private-storage-recovery-manifest.json"].bytes,
    );
  } catch {
    fail("manifest_invalid");
  }
  const restore = parseEvidence(productionRecoveryPrivateRestoreSchema,
    parseJson(files["private-storage-restore-receipt.json"], "restore_invalid"),
    "restore_invalid");
  const worm = parseEvidence(privateWormResultSchema,
    parseJson(files["private-storage-worm-receipt.json"], "worm_invalid"), "worm_invalid");
  const retrieval = parseEvidence(privateWormRetrievalSchema, parseJson(
    files["private-storage-worm-retrieval-receipt.json"], "worm_invalid",
  ), "worm_invalid");
  const logical = manifest.logicalBackup;
  if (backupManifest.schemaVersion !== 3 || !backupManifest.transport
    || logical.candidateSha !== input.candidateSha
    || logical.sourceEnvironment !== "production"
    || manifest.capturedAt !== capture.capturedAt
    || logical.archiveSha256 !== backupManifest.archive.sha256
    || logical.stateReceiptSha256 !== backupManifest.state.receiptSha256
    || logical.sourceDatabaseIdentitySha256
      !== backupManifest.state.sourceDatabaseIdentitySha256
    || logical.sourceUrlSha256 !== backupManifest.state.sourceUrlSha256
    || logical.overallStateSha256 !== backupManifest.state.overallStateSha256
    || restore.candidateSha !== input.candidateSha
    || restore.targetDatabaseIdentitySha256 !== input.targetDatabaseIdentitySha256
    || capture.recoverySetSha256 !== manifest.recoverySetSha256
    || restore.recoverySetSha256 !== manifest.recoverySetSha256
    || capture.recoveryManifestSha256
      !== files["private-storage-recovery-manifest.json"].sha256
    || restore.recoveryManifestSha256
      !== files["private-storage-recovery-manifest.json"].sha256
    || capture.logicalBackupManifestSha256 !== files["logical-backup-manifest.json"].sha256
    || logical.manifestSha256 !== files["logical-backup-manifest.json"].sha256
    || capture.storageObjectCount !== manifest.sourceStorage.objectCount
    || capture.databaseReferenceCount !== manifest.sourceStorage.databaseReferenceCount
    || capture.deletionTombstoneCount !== manifest.deletionAuthority.tombstoneCount
    || capture.databaseConnectionUrlSha256 !== logical.captureUrlSha256
    || capture.databaseTransportRootCaDerSha256
      !== backupManifest.transport.rootCaCertificateSha256
    || restore.destinationOriginSha256 !== input.targetSupabaseOriginSha256
    || restore.destinationBucketNameSha256 !== manifest.sourceStorage.bucketNameSha256
    || restore.destinationRailwayProjectIdSha256 !== input.targetProjectIdSha256
    || restore.destinationRailwayEnvironmentIdSha256 !== input.targetEnvironmentIdSha256
    || restore.deletionAuthoritySetSha256 !== manifest.deletionAuthority.authoritySetSha256
    || restore.restoredObjectCount !== manifest.sourceStorage.objectCount
    || restore.restoredBytes !== manifest.sourceStorage.totalBytes
    || restore.destinationObjectSetSha256 !== manifest.sourceStorage.objectSetSha256
    || restore.databaseTransportRootCaDerSha256
      !== backupManifest.transport.rootCaCertificateSha256
    || restore.destinationConnectionUrlSha256 === capture.databaseConnectionUrlSha256
    || worm.candidateSha !== input.candidateSha
    || worm.recoverySetSha256 !== manifest.recoverySetSha256
    || worm.recoveryManifestSha256 !== files["private-storage-recovery-manifest.json"].sha256
    || worm.logicalBackupManifestSha256 !== files["logical-backup-manifest.json"].sha256
    || retrieval.candidateSha !== input.candidateSha
    || retrieval.recoverySetSha256 !== worm.recoverySetSha256
    || retrieval.recoveryManifestSha256 !== worm.recoveryManifestSha256
    || retrieval.logicalBackupManifestSha256 !== worm.logicalBackupManifestSha256
    || retrieval.bundleManifestSha256 !== worm.bundleManifestSha256
    || retrieval.wormResultSha256 !== files["private-storage-worm-receipt.json"].sha256
    || retrieval.wormReceiptSha256 !== worm.receiptSha256
    || retrieval.immutableObjectSetSha256 !== worm.immutableObjectSetSha256
    || retrieval.recoveryAccountIdSha256 !== worm.recoveryAccountIdSha256
    || retrieval.bucketNameSha256 !== worm.bucketNameSha256
    || retrieval.readerPrincipalArnSha256 !== worm.readerPrincipalArnSha256
    || retrieval.minimumRetainUntil !== worm.minimumRetainUntil
    || retrieval.recoveredEntryCount !== Number(restore.restoredObjectCount) + 4) {
    fail("worm_invalid");
  }
  const capturedAt = exactTimestamp(capture.capturedAt, "capture_invalid");
  const sealedAt = exactTimestamp(worm.completedAt, "worm_invalid");
  const retainUntil = exactTimestamp(worm.minimumRetainUntil, "worm_invalid");
  const recoveredAt = exactTimestamp(retrieval.recoveredAt, "worm_invalid");
  const restoredAt = exactTimestamp(restore.restoredAt, "restore_invalid");
  if (Date.parse(sealedAt) < Date.parse(capturedAt)
    || Date.parse(retainUntil) <= Date.parse(sealedAt)
    || Date.parse(recoveredAt) < Date.parse(sealedAt)
    || Date.parse(restoredAt) < Date.parse(recoveredAt)) fail("worm_invalid");
}

function verifyLogicalWormRetrieval(files) {
  let manifest;
  try {
    manifest = parsePostgresLogicalBackupManifest(files["logical-backup-manifest.json"].bytes);
  } catch {
    fail("logical_worm_invalid");
  }
  const archive = object(manifest.archive, "logical_worm_invalid");
  const state = object(manifest.state, "logical_worm_invalid");
  const worm = parseEvidence(logicalWormResultSchema,
    parseJson(files["logical-worm-result.json"], "logical_worm_invalid"),
    "logical_worm_invalid");
  const retrieval = parseEvidence(logicalWormRetrievalSchema, parseJson(
    files["logical-worm-retrieval-receipt.json"], "logical_worm_retrieval_invalid",
  ), "logical_worm_retrieval_invalid");
  const restore = parseEvidence(productionRecoveryLogicalRestoreReceiptSchema,
    parseJson(files["logical-restore-receipt.json"], "logical_restore_invalid"),
    "logical_restore_invalid");
  const privateRestore = parseEvidence(productionRecoveryPrivateRestoreSchema,
    parseJson(files["private-storage-restore-receipt.json"], "restore_invalid"),
    "restore_invalid");
  if (manifest.schemaVersion !== 3
    || archive.file !== "pintpath-postgres.dump"
    || state.receiptFile !== "state-receipt.json"
    || worm.backupCreatedAt !== manifest.createdAt
    || worm.archiveSha256 !== archive.sha256
    || worm.manifestSha256 !== files["logical-backup-manifest.json"].sha256
    || worm.stateReceiptSha256 !== state.receiptSha256
    || worm.overallStateSha256 !== state.overallStateSha256
    || worm.backupIdSha256 !== hash(`${String(manifest.createdAt).replace(/[-:.]/g, "")}-${
      files["logical-backup-manifest.json"].sha256}`)
    || retrieval.backupCreatedAt !== manifest.createdAt
    || retrieval.archiveSha256 !== archive.sha256
    || retrieval.manifestSha256 !== files["logical-backup-manifest.json"].sha256
    || retrieval.stateReceiptSha256 !== state.receiptSha256
    || retrieval.sourceDatabaseIdentitySha256 !== state.sourceDatabaseIdentitySha256
    || retrieval.overallStateSha256 !== state.overallStateSha256
    || retrieval.wormResultSha256 !== files["logical-worm-result.json"].sha256
    || retrieval.wormReceiptSha256 !== worm.receiptSha256
    || retrieval.immutableObjectSetSha256 !== worm.immutableObjectSetSha256
    || retrieval.backupIdSha256 !== worm.backupIdSha256
    || retrieval.recoveryAccountIdSha256 !== worm.recoveryAccountIdSha256
    || retrieval.bucketNameSha256 !== worm.bucketNameSha256
    || retrieval.readerPrincipalArnSha256 !== worm.readerPrincipalArnSha256
    || retrieval.minimumRetainUntil !== worm.minimumRetainUntil
    || !Number.isSafeInteger(retrieval.archiveBytes)
    || retrieval.archiveBytes !== archive.bytes
    || !Number.isSafeInteger(retrieval.manifestBytes)
    || retrieval.manifestBytes !== files["logical-backup-manifest.json"].bytes.length
    || !Number.isSafeInteger(retrieval.stateReceiptBytes)
    || retrieval.stateReceiptBytes < 1
    || retrieval.localArtifactSetSha256 !== canonicalHash([
      { filename: String(archive.file), bytes: retrieval.archiveBytes,
        sha256: retrieval.archiveSha256 },
      { filename: "manifest.json", bytes: retrieval.manifestBytes,
        sha256: retrieval.manifestSha256 },
      { filename: String(state.receiptFile), bytes: retrieval.stateReceiptBytes,
        sha256: retrieval.stateReceiptSha256 },
    ])
    || restore.backupManifestSha256 !== retrieval.manifestSha256
    || restore.backupArchiveSha256 !== retrieval.archiveSha256
    || restore.targetIdentitySha256 !== privateRestore.targetDatabaseIdentitySha256
    || restore.targetUrlSha256 !== privateRestore.destinationConnectionUrlSha256
    || restore.authoritativeTableCount !== state.authoritativeTableCount
    || restore.authoritativeRowCount !== state.authoritativeRowCount
    || restore.schemaMetadataSha256 !== state.schemaMetadataSha256
    || restore.expectedSourceStateReceiptSha256 !== retrieval.stateReceiptSha256
    || restore.sourceSnapshotBindingSha256 !== state.snapshotBindingSha256
    || restore.expectedSourceTableSetSha256 !== state.tableSetSha256
    || restore.expectedSourceDataSha256 !== state.transformedDataSha256
    || restore.expectedSourceStateTotalsSha256 !== state.stateTotalsSha256
    || restore.expectedSourceKeyRangesSha256 !== state.keyRangesSha256
    || restore.expectedArchivedControlTableSetSha256 !== state.archivedControlTableSetSha256
    || restore.expectedArchivedControlDataSha256 !== state.archivedControlDataSha256
    || restore.expectedArchivedControlKeyRangesSha256 !== state.archivedControlKeyRangesSha256
    || restore.expectedSourceOverallStateSha256 !== retrieval.overallStateSha256
    || restore.sourceStateBindingStatus !== "exact-match") fail("logical_worm_retrieval_invalid");
  const sealedAt = exactTimestamp(worm.completedAt, "logical_worm_invalid");
  const retainedUntil = exactTimestamp(worm.minimumRetainUntil, "logical_worm_invalid");
  const retrievedAt = exactTimestamp(retrieval.retrievedAt, "logical_worm_retrieval_invalid");
  const restoredAt = exactTimestamp(restore.restoredAt, "logical_restore_invalid");
  if (Date.parse(retainedUntil) <= Date.parse(sealedAt)
    || Date.parse(retrievedAt) < Date.parse(sealedAt)
    || Date.parse(restoredAt) < Date.parse(retrievedAt)) {
    fail("logical_worm_retrieval_invalid");
  }
}

function verifyOperationalOffsite(files) {
  let manifest;
  try {
    manifest = parsePostgresLogicalBackupManifest(files["logical-backup-manifest.json"].bytes);
  } catch {
    fail("logical_offsite_invalid");
  }
  const offsite = parseEvidence(productionRecoveryLogicalOffsiteResultSchema,
    parseJson(files["logical-offsite-result.json"], "logical_offsite_invalid"),
    "logical_offsite_invalid");
  const retrieval = parseEvidence(productionRecoveryLogicalOffsiteRetrievalSchema,
    parseJson(files["offsite-retrieval-receipt.json"], "offsite_retrieval_invalid"),
    "offsite_retrieval_invalid");
  const expectedBackupIdSha256 = hash(
    `${manifest.createdAt.replace(/[-:.]/g, "")}-${files["logical-backup-manifest.json"].sha256}`,
  );
  const localArtifacts = [
    { filename: "manifest.json", bytes: retrieval.manifestBytes,
      sha256: retrieval.manifestSha256, mode: "0600" },
    { filename: "pintpath-postgres.dump", bytes: retrieval.archiveBytes,
      sha256: retrieval.archiveSha256, mode: "0600" },
    { filename: "state-receipt.json", bytes: retrieval.stateReceiptBytes,
      sha256: retrieval.stateReceiptSha256, mode: "0600" },
  ];
  if (offsite.backupCreatedAt !== manifest.createdAt
    || offsite.archiveSha256 !== manifest.archive.sha256
    || offsite.manifestSha256 !== files["logical-backup-manifest.json"].sha256
    || offsite.stateReceiptSha256 !== manifest.state.receiptSha256
    || offsite.sourceDatabaseIdentitySha256 !== manifest.state.sourceDatabaseIdentitySha256
    || offsite.overallStateSha256 !== manifest.state.overallStateSha256
    || offsite.backupIdSha256 !== expectedBackupIdSha256
    || retrieval.retrievedAt < offsite.completedAt
    || retrieval.successStateSha256 !== offsite.successStateSha256
    || retrieval.backupCreatedAt !== offsite.backupCreatedAt
    || retrieval.backupIdSha256 !== offsite.backupIdSha256
    || retrieval.latestPointerSha256 !== offsite.latestPointerSha256
    || retrieval.attestationSha256 !== offsite.attestationSha256
    || retrieval.remoteObjectSetSha256 !== offsite.remoteObjectSetSha256
    || retrieval.archiveSha256 !== offsite.archiveSha256
    || retrieval.manifestSha256 !== offsite.manifestSha256
    || retrieval.stateReceiptSha256 !== offsite.stateReceiptSha256
    || retrieval.sourceDatabaseIdentitySha256 !== offsite.sourceDatabaseIdentitySha256
    || retrieval.overallStateSha256 !== offsite.overallStateSha256
    || retrieval.archiveBytes !== manifest.archive.bytes
    || retrieval.manifestBytes !== files["logical-backup-manifest.json"].bytes.length
    || retrieval.localArtifactSetSha256 !== canonicalHash(localArtifacts)) {
    fail("offsite_retrieval_invalid");
  }
}

function verifyPitr(files, input) {
  let manifest;
  try {
    manifest = parsePostgresLogicalBackupManifest(files["logical-backup-manifest.json"].bytes);
  } catch {
    fail("pitr_invalid");
  }
  const pitr = parseEvidence(productionRecoveryPitrReceiptSchema,
    parseJson(files["pitr-receipt.json"], "pitr_invalid"), "pitr_invalid");
  if (pitr.candidateSha !== input.candidateSha
    || pitr.recoveryPointAt !== manifest.createdAt) fail("pitr_invalid");
  const enabledAt = exactTimestamp(pitr.pitrEnabledAt, "pitr_invalid");
  const recoveryPointAt = exactTimestamp(pitr.recoveryPointAt, "pitr_invalid");
  const observedAt = exactTimestamp(pitr.observedAt, "pitr_invalid");
  if (Date.parse(enabledAt) > Date.parse(recoveryPointAt)
    || Date.parse(recoveryPointAt) > Date.parse(observedAt)) fail("pitr_invalid");
}

function verifySmokeAndCleanup(files, input) {
  const smoke = parseEvidence(productionRecoveryRecoveredApplicationSchema,
    parseJson(files["recovered-smoke-receipt.json"], "smoke_invalid"), "smoke_invalid");
  const purge = parseEvidence(storagePurgeReceiptSchema,
    parseJson(files["storage-purge-receipt.json"], "purge_invalid"), "purge_invalid");
  const railway = parseEvidence(railwayTerminalSchema,
    parseJson(files["railway-teardown-terminal.json"], "railway_invalid"), "railway_invalid");
  const supabase = parseEvidence(supabaseTerminalSchema,
    parseJson(files["supabase-teardown-terminal.json"], "supabase_invalid"),
    "supabase_invalid");
  const railwayReceipt = railway.receipt;
  const supabaseReceipt = supabase.receipt;
  const recoveryManifest = parseJson(
    files["private-storage-recovery-manifest.json"], "purge_invalid",
  );
  const storageRestore = parseEvidence(productionRecoveryPrivateRestoreSchema, parseJson(
    files["private-storage-restore-receipt.json"], "purge_invalid",
  ), "purge_invalid");
  let firstReplay, secondReplay;
  try {
    firstReplay = parsePostgresAccountDeletionReplayReceipt(parseJson(
      files["deletion-replay-first-receipt.json"], "smoke_invalid",
    ));
    secondReplay = parsePostgresAccountDeletionReplayReceipt(parseJson(
      files["deletion-replay-second-receipt.json"], "smoke_invalid",
    ));
  } catch {
    fail("smoke_invalid");
  }
  if (smoke.kind !== "pintpath-recovered-postgres-application-smoke"
    || smoke.status !== "verified" || smoke.ok !== true
    || smoke.candidateSha !== input.candidateSha
    || smoke.targetIdentitySha256 !== input.targetDatabaseIdentitySha256
    || smoke.firstReplayReceiptSha256
      !== files["deletion-replay-first-receipt.json"].sha256
    || smoke.secondReplayReceiptSha256
      !== files["deletion-replay-second-receipt.json"].sha256
    || smoke.semanticProjectionSha256 !== firstReplay.semanticProjectionSha256
    || smoke.semanticProjectionSha256 !== secondReplay.semanticProjectionSha256
    || smoke.tombstoneCount !== firstReplay.ledgerTombstoneCount
    || smoke.tombstoneCount !== secondReplay.ledgerTombstoneCount
    || smoke.compiledArtifactExact !== true
    || smoke.runtimeRoleExact !== true || smoke.maintenanceRoleRestricted !== true
    || smoke.applicationStateReady !== true || smoke.deletionPrivacyReconciled !== true
    || smoke.compiledApplicationStarted !== true || smoke.startupRouteReady !== true
    || smoke.startupProbeExact !== true || smoke.readyProbeExact !== true
    || smoke.readyRouteReady !== true || smoke.authenticatedBoundaryExact !== true
    || smoke.authenticatedRuntimeExact !== true
    || smoke.restoredAuthAccountPreexistingExact !== true
    || smoke.noAdminOrVenueElevationExact !== true
    || smoke.noPrivateDataLeakageExact !== true
    || smoke.crossProjectTokenParserRejectedLocallyExact !== true
    || smoke.appSessionRevokedExact !== true || smoke.providerSessionLogoutExact !== true
    || smoke.automaticMaintenanceWorkersExternalWritesDisabledExact !== true
    || smoke.runtimeDependencyBoundaryExact !== true
    || smoke.childOutputBoundedRedactedExact !== true || smoke.childTerminatedExact !== true
    || smoke.applicationChildTerminated !== true
    || smoke.databaseAuthoritiesClosedExact !== true || smoke.transportClosedExact !== true
    || smoke.supabaseOriginSha256 !== input.targetSupabaseOriginSha256
    || !SHA256.test(String(smoke.compiledArtifactSha256))
    || !SHA256.test(String(smoke.compiledEntrypointSha256))
    || !SHA256.test(String(smoke.authSubjectSha256))
    || !SHA256.test(String(smoke.authEmailSha256))
    || !SHA256.test(String(smoke.supabasePublishableKeySha256))
    || !SHA256.test(String(smoke.runtimeDatabaseUrlSha256))
    || !SHA256.test(String(smoke.maintenanceDatabaseUrlSha256))
    || smoke.runtimeDatabaseUrlSha256 === smoke.maintenanceDatabaseUrlSha256
    || smoke.maintenanceDatabaseUrlSha256 !== storageRestore.destinationConnectionUrlSha256
    || !SHA256.test(String(smoke.redisUrlSha256))
    || smoke.transportProfile !== "railway-stock-localhost-ca-v1"
    || smoke.transportRootCaDerSha256 !== storageRestore.databaseTransportRootCaDerSha256
    || smoke.transportRootCaDerSha256 !== firstReplay.transportRootCaDerSha256
    || smoke.transportRootCaDerSha256 !== secondReplay.transportRootCaDerSha256
    || purge.candidateSha !== input.candidateSha
    || purge.targetRailwayProjectIdSha256 !== input.targetProjectIdSha256
    || purge.targetRailwayEnvironmentIdSha256 !== input.targetEnvironmentIdSha256
    || purge.targetDatabaseIdentitySha256 !== input.targetDatabaseIdentitySha256
    || purge.destinationOriginSha256 !== input.targetSupabaseOriginSha256
    || purge.destinationProjectRefSha256 !== hash(supabaseReceipt.projectRef)
    || purge.bucketNameSha256 !== hash("beermap-source-evidence")
    || purge.destinationRestoreAuthoritySha256 !== storageRestore.destinationAuthoritySha256
    || purge.recoverySetSha256 !== recoveryManifest.recoverySetSha256
    || purge.recoveryManifestSha256
      !== files["private-storage-recovery-manifest.json"].sha256
    || purge.restoreReceiptSha256 !== files["private-storage-restore-receipt.json"].sha256
    || purge.restoredObjectSetSha256 !== storageRestore.destinationObjectSetSha256
    || purge.removedObjectCount !== storageRestore.restoredObjectCount
    || railwayReceipt.candidateSha !== input.candidateSha
    || railwayReceipt.observedCleanupRunId !== input.runId
    || railwayReceipt.signedActivationRunId !== input.runId
    || hash(String(railwayReceipt.projectId)) !== input.targetProjectIdSha256
    || hash(String(railwayReceipt.environmentId)) !== input.targetEnvironmentIdSha256
    || supabaseReceipt.candidateSha !== input.candidateSha
    || supabaseReceipt.observedCleanupRunId !== input.runId
    || supabaseReceipt.signedActivationRunId !== input.runId
    || supabaseReceipt.cleanupMode !== "orderly"
    || supabaseReceipt.purgeReceiptSha256 !== files["storage-purge-receipt.json"].sha256
    || supabaseReceipt.destinationOriginSha256 !== input.targetSupabaseOriginSha256
    || supabaseReceipt.destinationOriginSha256
      !== hash(`https://${supabaseReceipt.projectRef}.supabase.co`)
    || supabaseReceipt.destinationRestoreAuthoritySha256
      !== storageRestore.destinationAuthoritySha256
    || hash(String(supabaseReceipt.targetRailwayProjectId)) !== input.targetProjectIdSha256
    || hash(String(supabaseReceipt.targetRailwayEnvironmentId))
      !== input.targetEnvironmentIdSha256
    ) fail("cleanup_invalid");
  const readyAt = exactTimestamp(smoke.applicationReadyAt, "smoke_invalid");
  const smokeCompletedAt = exactTimestamp(smoke.completedAt, "smoke_invalid");
  const purgeCompletedAt = exactTimestamp(purge.completedAt, "purge_invalid");
  const railwayCompletedAt = exactTimestamp(railwayReceipt.completedAt, "railway_invalid");
  const supabaseCompletedAt = exactTimestamp(supabaseReceipt.completedAt, "supabase_invalid");
  if (Date.parse(smokeCompletedAt) < Date.parse(readyAt)
    || Date.parse(purgeCompletedAt) < Date.parse(smokeCompletedAt)
    || Date.parse(railwayCompletedAt) < Date.parse(purgeCompletedAt)
    || Date.parse(supabaseCompletedAt) < Date.parse(purgeCompletedAt)) fail("cleanup_invalid");
  return { railwayCompletedAt, supabaseCompletedAt };
}

export function verifyProductionPromotionRecoveryActivationEvidence(files, input) {
  if (canonicalProductionPromotionRecoveryActivationJson(
    PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_EVIDENCE,
  ) !== canonicalProductionPromotionRecoveryActivationJson(
    PRODUCTION_PROMOTION_RECOVERY_EXACT_SCHEMA_EVIDENCE,
  )) {
    fail("schema_coverage_invalid");
  }
  const first = parseJson(files["deletion-replay-first-receipt.json"], "replay_invalid");
  const second = parseJson(files["deletion-replay-second-receipt.json"], "replay_invalid");
  verifyReplay(first, second, input, files);
  verifyPitr(files, input);
  verifyOperationalOffsite(files);
  verifyLogicalWormRetrieval(files);
  verifyRecoveryBundle(files, input);
  return verifySmokeAndCleanup(files, input);
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  now: () => new Date(),
  holdDirectory: (directory) => holdPrivateDirectoryIdentity(directory, {
    requireExactDirectoryMode: true, requireOwner: true,
  }),
  readFile: (filename) => readTrustedRegularFile(filename, {
    minBytes: 1, maxBytes: MAX_EVIDENCE_BYTES, requirePrivate: true, requireOwner: true,
  }),
  writeFile: (directory, leaf, source, expectedDirectoryIdentity) =>
    writePrivateExclusiveFile(directory, leaf, source, {
      requireExactDirectoryMode: true, requireOwner: true, expectedDirectoryIdentity,
    }),
});

export function createProductionPromotionRecoveryActivationReceipt(argv, overrides = {}) {
  const input = parseArgs(argv);
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const heldDirectory = dependencies.holdDirectory(input.directory);
  let closed = false;
  try {
    const files = Object.fromEntries(PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_EVIDENCE.map(
      (leaf) => {
        heldDirectory.assertExact();
        const bytes = dependencies.readFile(path.join(input.directory, leaf));
        heldDirectory.assertExact();
        return [leaf, { bytes, sha256: hash(bytes) }];
      },
    ));
    const evidenceInput = {
      candidateSha: input.candidateSha,
      runId: input.runId,
      targetProjectIdSha256: hash(input.targetProjectId),
      targetEnvironmentIdSha256: hash(input.targetEnvironmentId),
      targetDatabaseIdentitySha256: input.targetDatabaseIdentitySha256,
      targetSupabaseOriginSha256: input.targetSupabaseOriginSha256,
    };
    const cleanup = verifyProductionPromotionRecoveryActivationEvidence(files, evidenceInput);
    const completedAt = dependencies.now().toISOString();
    exactTimestamp(completedAt, "clock_invalid");
    if (Date.parse(completedAt) < Math.max(
      Date.parse(cleanup.railwayCompletedAt), Date.parse(cleanup.supabaseCompletedAt),
    )) fail("clock_invalid");
    const evidence = PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_EVIDENCE.map((leaf) => ({
      leaf, sha256: files[leaf].sha256,
    }));
    const cleanupEvidence = PRODUCTION_PROMOTION_RECOVERY_CLEANUP_EVIDENCE.map((leaf) => ({
      leaf, sha256: files[leaf].sha256,
    }));
    const withoutHash = {
      schemaVersion: 1,
      kind: "pintpath-production-promotion-recovery-activation",
      candidateSha: input.candidateSha,
      producerWorkflow: "activate-production-promotion-recovery.yml",
      producerRunId: input.runId,
      producerRunAttempt: input.runAttempt,
      completedAt,
      targetProjectIdSha256: evidenceInput.targetProjectIdSha256,
      targetEnvironmentIdSha256: evidenceInput.targetEnvironmentIdSha256,
      targetDatabaseIdentitySha256: input.targetDatabaseIdentitySha256,
      targetSupabaseOriginSha256: input.targetSupabaseOriginSha256,
      evidence,
      evidenceAggregateSha256: canonicalHash(evidence),
      cleanupEvidenceAggregateSha256: canonicalHash(cleanupEvidence),
      allOperationsExact: true,
      targetAbsent: true,
    };
    const receipt = { ...withoutHash, receiptSha256: canonicalHash(withoutHash) };
    const directoryIdentity = heldDirectory.identity;
    heldDirectory.assertExact();
    heldDirectory.close();
    closed = true;
    dependencies.writeFile(
      input.directory, "activation-receipt.json",
      canonicalProductionPromotionRecoveryActivationJson(receipt), directoryIdentity,
    );
    return receipt;
  } catch (error) {
    if (!closed) {
      try {
        heldDirectory.close();
      } catch {
        fail("output_unsafe");
      }
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = createProductionPromotionRecoveryActivationReceipt(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ ok: true, receiptSha256: receipt.receiptSha256 })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "activation_receipt_failed"}\n`);
    process.exitCode = 1;
  }
}
