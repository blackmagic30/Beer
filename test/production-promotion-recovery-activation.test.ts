import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalProductionPromotionRecoveryActivationJson as canonical,
  createProductionPromotionRecoveryActivationReceipt,
  PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_EVIDENCE,
  PRODUCTION_PROMOTION_RECOVERY_EXACT_SCHEMA_EVIDENCE,
} from "../scripts/create-production-promotion-recovery-activation-receipt.mjs";
import { main as writeGithubAuthority } from "../scripts/verify-github-production-promotion-recovery-activation.mjs";
import { verifyProductionPromotionRecoveryActivation } from "../scripts/verify-production-promotion-recovery-activation.mjs";
import {
  holdPrivateDirectoryIdentity,
  writePrivateExclusiveFile,
} from "../scripts/lib/trusted-filesystem.js";
import { postgresPrivateStorageRecoveryInternals } from
  "../src/lib/postgres-private-storage-recovery.js";
import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import { sha256ProductionPromotionRecoveryValue } from
  "../src/lib/production-promotion-recovery.js";
import { writeLogicalOffsiteFixture } from "./postgres-logical-offsite.fixtures.js";

const candidateSha = "a".repeat(40);
const targetProjectId = "11111111-1111-4111-8111-111111111111";
const targetEnvironmentId = "22222222-2222-4222-8222-222222222222";
const targetDatabaseIdentitySha256 = "3".repeat(64);
const targetSupabaseProjectRef = "abcdefghijklmnopqrst";
const targetSupabaseOriginSha256 = sha(
  `https://${targetSupabaseProjectRef}.supabase.co`,
);
const runId = "123456789";
const roots: string[] = [];

function sha(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tempDirectory(label: string): string {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), `pintpath-${label}-`));
  const root = fs.realpathSync(created);
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function write(directory: string, leaf: string, value: unknown): Buffer {
  const bytes = Buffer.from(
    typeof value === "string" ? value : canonical(value),
    "utf8",
  );
  fs.writeFileSync(path.join(directory, leaf), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  return bytes;
}

function withReceiptHash(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return { ...value, receiptSha256: sha256ProductionPromotionRecoveryValue(value) };
}

function activationArgs(directory: string): string[] {
  return [
    "--directory",
    directory,
    "--candidate-sha",
    candidateSha,
    "--run-id",
    runId,
    "--run-attempt",
    "1",
    "--target-project-id",
    targetProjectId,
    "--target-environment-id",
    targetEnvironmentId,
    "--target-database-identity-sha256",
    targetDatabaseIdentitySha256,
    "--target-supabase-origin-sha256",
    targetSupabaseOriginSha256,
    "--output",
    path.join(directory, "activation-receipt.json"),
  ];
}

function makeEvidence(
  directory: string,
  options: {
    readonly candidate?: string;
    readonly retainUntil?: string;
  } = {},
): void {
  const candidate = options.candidate ?? candidateSha;
  const fixtureRoot = tempDirectory("activation-logical-fixture");
  const backup = writeLogicalOffsiteFixture(
    fixtureRoot, "2026-01-01T00:05:00.000Z", 3,
  );
  const logicalManifest = write(directory, "logical-backup-manifest.json", fs.readFileSync(
    path.join(backup.backupDirectory, "manifest.json"), "utf8",
  ));
  const archiveSha256 = backup.archiveSha256;
  const stateReceiptSha256 = backup.receiptSha256;
  const sourceDatabaseIdentitySha256 = backup.manifest.state.sourceDatabaseIdentitySha256;
  const overallStateSha256 = backup.manifest.state.overallStateSha256;
  const transportRootCaDerSha256 = backup.manifest.schemaVersion === 3
    ? backup.manifest.transport.rootCaCertificateSha256
    : "";
  const targetConnectionUrlSha256 = "0".repeat(64);
  const archiveBytes = backup.manifest.archive.bytes;
  const stateReceiptBytes = fs.readFileSync(
    path.join(backup.backupDirectory, "state-receipt.json"),
  ).length;
  const recoveryObjects = [{
    objectPath: "screenshots/source.png",
    bytes: 4,
    sha256: "1".repeat(64),
    contentType: "image/png",
    sourceStorageObjectIdSha256: "2".repeat(64),
    sourceStorageVersionSha256: "3".repeat(64),
    referencedByDatabase: true,
  }];
  const recoveryManifestWithoutBinding = {
    kind: "pintpath-postgres-private-storage-recovery-set",
    version: 2,
    capturedAt: "2026-01-01T00:07:00.000Z",
    logicalBackup: {
      manifestSha256: sha(logicalManifest),
      archiveSha256,
      stateReceiptSha256,
      sourceDatabaseIdentitySha256,
      sourceUrlSha256: backup.manifest.state.sourceUrlSha256,
      captureUrlSha256: "4".repeat(64),
      migrationRunSha256: "5".repeat(64),
      sourceEnvironment: "production",
      candidateSha: candidate,
      overallStateSha256,
      sourceEvidenceTableSha256: "6".repeat(64),
    },
    sourceStorage: {
      originSha256: sha("https://jxpubqlmqnnqwadmjgyk.supabase.co"),
      bucketNameSha256: sha("beermap-source-evidence"),
      objectCount: 1,
      databaseReferenceCount: 1,
      orphanObjectCount: 0,
      totalBytes: "4",
      sourceInventorySha256: sha(canonical(recoveryObjects.map((object) => ({
        objectPath: object.objectPath,
        bytes: object.bytes,
        contentType: object.contentType,
        storageObjectIdSha256: object.sourceStorageObjectIdSha256,
        storageVersionSha256: object.sourceStorageVersionSha256,
      })))),
      objectSetSha256: sha(canonical(recoveryObjects)),
      objects: recoveryObjects,
    },
    deletionAuthority: {
      currentSha256: "7".repeat(64),
      genesisSha256: "8".repeat(64),
      checkpointSha256: "9".repeat(64),
      immutableSetSha256: "a".repeat(64),
      tombstoneCount: 2,
      latestCompletedAt: "2026-01-01T00:06:30.000Z",
      authoritySetSha256: "b".repeat(64),
    },
  };
  const recoverySetSha256 = postgresPrivateStorageRecoveryInternals.recoverySetBinding(
    recoveryManifestWithoutBinding,
  );
  const recoveryManifest = write(
    directory,
    "private-storage-recovery-manifest.json",
    canonicalPostgresBackupJson({
      ...recoveryManifestWithoutBinding,
      recoverySetSha256,
    }),
  );
  const recoveryManifestSha256 = sha(recoveryManifest);
  const backupIdSha256 = sha(
    `${backup.manifest.createdAt.replace(/[-:.]/g, "")}-${sha(logicalManifest)}`,
  );
  const remoteObjectSetSha256 = "c".repeat(64);
  const attestationSha256 = "d".repeat(64);
  const latestPointerSha256 = "e".repeat(64);
  const successStateSha256 = "f".repeat(64);
  write(directory, "logical-offsite-result.json", {
    schemaVersion: 1,
    ok: true,
    backupCreatedAt: backup.manifest.createdAt,
    completedAt: "2026-01-01T00:08:00.000Z",
    archiveSha256,
    manifestSha256: sha(logicalManifest),
    stateReceiptSha256,
    overallStateSha256,
    sourceDatabaseIdentitySha256,
    remoteObjectSetSha256,
    attestationSha256,
    latestPointerSha256,
    backupIdSha256,
    successStateSha256,
  });
  write(directory, "offsite-retrieval-receipt.json", {
    schemaVersion: 1,
    kind: "pintpath-postgres-logical-offsite-retrieval",
    ok: true,
    retrievedAt: "2026-01-01T00:10:00.000Z",
    successStateSha256,
    backupCreatedAt: backup.manifest.createdAt,
    backupIdSha256,
    latestPointerSha256,
    attestationSha256,
    remoteObjectSetSha256,
    archiveSha256,
    manifestSha256: sha(logicalManifest),
    stateReceiptSha256,
    sourceDatabaseIdentitySha256,
    overallStateSha256,
    archiveBytes,
    manifestBytes: logicalManifest.length,
    stateReceiptBytes,
    localArtifactSetSha256: sha(canonical([
      { filename: "manifest.json", bytes: logicalManifest.length,
        sha256: sha(logicalManifest), mode: "0600" },
      { filename: "pintpath-postgres.dump", bytes: archiveBytes,
        sha256: archiveSha256, mode: "0600" },
      { filename: "state-receipt.json", bytes: stateReceiptBytes,
        sha256: stateReceiptSha256, mode: "0600" },
    ])),
  });
  const immutableObjectSetSha256 = "5".repeat(64);
  const wormReceiptSha256 = "6".repeat(64);
  const recoveryAccountIdSha256 = "7".repeat(64);
  const bucketNameSha256 = "8".repeat(64);
  const readerPrincipalArnSha256 = "9".repeat(64);
  const minimumRetainUntil = options.retainUntil ?? "2033-01-01T00:09:00.000Z";
  const logicalWorm = write(directory, "logical-worm-result.json", {
    schemaVersion: 1,
    ok: true,
    backupCreatedAt: "2026-01-01T00:05:00.000Z",
    completedAt: "2026-01-01T00:09:00.000Z",
    archiveSha256,
    manifestSha256: sha(logicalManifest),
    stateReceiptSha256,
    overallStateSha256,
    backupIdSha256,
    recoveryAccountIdSha256,
    bucketNameSha256,
    writerPrincipalArnSha256: "a".repeat(64),
    readerPrincipalArnSha256,
    immutableObjectSetSha256,
    writerDenialSetSha256: "b".repeat(64),
    receiptSha256: wormReceiptSha256,
    receiptObjectKeySha256: "c".repeat(64),
    receiptVersionIdSha256: "d".repeat(64),
    receiptDenialSetSha256: "e".repeat(64),
    minimumRetainUntil,
  });
  const localArtifacts = [
    {
      filename: "pintpath-postgres.dump",
      bytes: archiveBytes,
      sha256: archiveSha256,
    },
    {
      filename: "manifest.json",
      bytes: logicalManifest.length,
      sha256: sha(logicalManifest),
    },
    {
      filename: "state-receipt.json",
      bytes: stateReceiptBytes,
      sha256: stateReceiptSha256,
    },
  ];
  write(directory, "logical-worm-retrieval-receipt.json", {
    schemaVersion: 1,
    kind: "pintpath-postgres-logical-worm-retrieval",
    ok: true,
    retrievedAt: "2026-01-01T00:10:00.000Z",
    backupCreatedAt: "2026-01-01T00:05:00.000Z",
    archiveSha256,
    manifestSha256: sha(logicalManifest),
    stateReceiptSha256,
    sourceDatabaseIdentitySha256,
    overallStateSha256,
    backupIdSha256,
    wormResultSha256: sha(logicalWorm),
    wormReceiptSha256,
    immutableObjectSetSha256,
    archiveBytes,
    manifestBytes: logicalManifest.length,
    stateReceiptBytes,
    localArtifactSetSha256: sha(canonical(localArtifacts)),
    recoveryAccountIdSha256,
    bucketNameSha256,
    readerPrincipalArnSha256,
    minimumRetainUntil,
  });
  const logicalRestore = write(directory, "logical-restore-receipt.json", {
    kind: "pintpath-postgres-logical-restore",
    version: 1,
    status: "verified",
    restoredAt: "2026-01-01T00:11:00.000Z",
    backupManifestSha256: sha(logicalManifest),
    backupArchiveSha256: archiveSha256,
    targetIdentitySha256: targetDatabaseIdentitySha256,
    targetUrlSha256: targetConnectionUrlSha256,
    authoritativeTableCount: backup.manifest.state.authoritativeTableCount,
    authoritativeColumnCount: 10,
    foreignKeyCount: 0,
    authoritativeRowCount: backup.manifest.state.authoritativeRowCount,
    nonEmptyAuthoritativeTableCount: 1,
    authoritativeCountInventorySha256: "1".repeat(64),
    controlCountInventorySha256: "2".repeat(64),
    schemaMetadataSha256: backup.manifest.state.schemaMetadataSha256,
    rowSecurityTableCount: 1,
    aclContractSha256: "3".repeat(64),
    apiRolesIsolated: true,
    runtimeApplicationAccessRestored: true,
    migratorReconciliationAccessVerified: true,
    runtimeOperationsIsolated: true,
    promotionReconciliationReady: true,
    expectedSourceStateReceiptSha256: stateReceiptSha256,
    sourceSnapshotBindingSha256: backup.manifest.state.snapshotBindingSha256,
    expectedSourceTableSetSha256: backup.manifest.state.tableSetSha256,
    expectedSourceDataSha256: backup.manifest.state.transformedDataSha256,
    expectedSourceStateTotalsSha256: backup.manifest.state.stateTotalsSha256,
    expectedSourceKeyRangesSha256: backup.manifest.state.keyRangesSha256,
    expectedArchivedControlTableSetSha256:
      backup.manifest.state.archivedControlTableSetSha256,
    expectedArchivedControlDataSha256: backup.manifest.state.archivedControlDataSha256,
    expectedArchivedControlKeyRangesSha256:
      backup.manifest.state.archivedControlKeyRangesSha256,
    expectedSourceOverallStateSha256: overallStateSha256,
    restoredOverallStateSha256: overallStateSha256,
    sourceStateBindingStatus: "exact-match",
    exactDataReconciliation: "canonical-contract-exact",
  });
  write(
    directory,
    "pitr-receipt.json",
    withReceiptHash({
      schemaVersion: "pintpath-production-post-promotion-pitr-observation/v1",
      outcome: "verified",
      candidateSha: candidate,
      productionDeploymentIdSha256: "0".repeat(64),
      recoveryPointAt: "2026-01-01T00:05:00.000Z",
      observedAt: "2026-01-01T00:06:00.000Z",
      pitrEnabledAt: "2026-01-01T00:04:00.000Z",
      projectIdSha256: sha(targetProjectId),
      environmentIdSha256: sha(targetEnvironmentId),
      rootServiceIdSha256: "5".repeat(64),
      pitrWorkflowIdSha256: "6".repeat(64),
      providerHealthSha256: "7".repeat(64),
      pitrEnabled: true,
      clusterHealthy: true,
    }),
  );
  write(directory, "private-storage-capture-receipt.json", {
    schemaVersion: 1,
    kind: "pintpath-postgres-private-storage-recovery-capture",
    ok: true,
    capturedAt: "2026-01-01T00:07:00.000Z",
    logicalBackupManifestSha256: sha(logicalManifest),
    storageObjectCount: 1,
    databaseReferenceCount: 1,
    deletionTombstoneCount: 2,
    recoverySetSha256,
    recoveryManifestSha256,
    databaseConnectionUrlSha256: recoveryManifestWithoutBinding.logicalBackup.captureUrlSha256,
    databaseTransportProfile: "railway-stock-localhost-ca-v1",
    databaseTransportRootCaDerSha256: transportRootCaDerSha256,
    databaseEffectiveRole: "pintpath_migrator",
  });
  const privateRestore = write(directory, "private-storage-restore-receipt.json", {
    schemaVersion: 1,
    kind: "pintpath-postgres-private-storage-recovery-restore",
    ok: true,
    candidateSha: candidate,
    restoredAt: "2026-01-01T00:12:00.000Z",
    targetDatabaseIdentitySha256,
    recoverySetSha256,
    recoveryManifestSha256,
    restoredObjectCount: 1,
    restoredBytes: "4",
    destinationObjectSetSha256: recoveryManifestWithoutBinding.sourceStorage.objectSetSha256,
    deletionAuthoritySetSha256:
      recoveryManifestWithoutBinding.deletionAuthority.authoritySetSha256,
    databaseTransportProfile: "railway-stock-localhost-ca-v1",
    databaseTransportRootCaDerSha256: transportRootCaDerSha256,
    databaseEffectiveRole: "pintpath_migrator",
    destinationConnectionUrlSha256: targetConnectionUrlSha256,
    destinationOriginSha256: targetSupabaseOriginSha256,
    destinationBucketNameSha256: recoveryManifestWithoutBinding.sourceStorage.bucketNameSha256,
    destinationAuthoritySha256: "5".repeat(64),
    destinationAuthorityPublicKeySha256: "6".repeat(64),
    destinationAuthorityReviewerIdSha256: "7".repeat(64),
    destinationRailwayProjectIdSha256: sha(targetProjectId),
    destinationRailwayEnvironmentIdSha256: sha(targetEnvironmentId),
  });
  const privateWorm = write(directory, "private-storage-worm-receipt.json", {
    schemaVersion: 1,
    ok: true,
    kind: "pintpath-postgres-private-storage-worm-receipt",
    candidateSha: candidate,
    completedAt: "2026-01-01T00:09:30.000Z",
    minimumRetainUntil: options.retainUntil ?? "2033-01-01T00:09:30.000Z",
    recoverySetSha256,
    recoveryManifestSha256,
    logicalBackupManifestSha256: sha(logicalManifest),
    bundleManifestSha256: "6".repeat(64),
    immutableObjectSetSha256: "8".repeat(64),
    recoveryAccountIdSha256: "9".repeat(64),
    bucketNameSha256: "a".repeat(64),
    writerPrincipalArnSha256: "b".repeat(64),
    readerPrincipalArnSha256: "7".repeat(64),
    writerDenialSetSha256: "c".repeat(64),
    receiptSha256: "d".repeat(64),
    receiptObjectKeySha256: "e".repeat(64),
    receiptVersionIdSha256: "f".repeat(64),
    receiptDenialSetSha256: "0".repeat(64),
  });
  write(directory, "private-storage-worm-retrieval-receipt.json", {
    schemaVersion: 1,
    ok: true,
    kind: "pintpath-postgres-private-storage-worm-retrieval",
    candidateSha: candidate,
    recoveredAt: "2026-01-01T00:10:30.000Z",
    recoverySetSha256,
    recoveryManifestSha256,
    logicalBackupManifestSha256: sha(logicalManifest),
    bundleManifestSha256: "6".repeat(64),
    wormResultSha256: sha(privateWorm),
    wormReceiptSha256: "d".repeat(64),
    immutableObjectSetSha256: "8".repeat(64),
    entrySetSha256: "1".repeat(64),
    recoveredEntryCount: 5,
    recoveredBytes: "1024",
    recoveryAccountIdSha256: "9".repeat(64),
    bucketNameSha256: "a".repeat(64),
    readerPrincipalArnSha256: "7".repeat(64),
    minimumRetainUntil: options.retainUntil ?? "2033-01-01T00:09:30.000Z",
  });
  const replay = (first: boolean) => ({
    kind: "pintpath-postgres-account-deletion-tombstone-replay",
    version: 2,
    status: "verified",
    replayedAt: first ? "2026-01-01T00:13:00.000Z" : "2026-01-01T00:14:00.000Z",
    targetIdentitySha256: targetDatabaseIdentitySha256,
    targetClass: "disposable-rehearsal",
    serverVersionNum: "170010",
    replayRoleRestricted: true,
    replayEffectiveRole: "pintpath_maintenance",
    transportProfile: "railway-stock-localhost-ca-v1",
    transportRootCaDerSha256,
    restoreLockKeySha256: "0".repeat(64),
    baseRestoreReceiptSha256: sha(logicalRestore),
    migrationCandidateSha: candidate,
    migrationManifestSha256: "1".repeat(64),
    migrationRunSha256: recoveryManifestWithoutBinding.logicalBackup.migrationRunSha256,
    sourceSnapshotSha256: "2".repeat(64),
    backupManifestSha256: sha(logicalManifest),
    backupArchiveSha256: archiveSha256,
    sourceStateReceiptSha256: stateReceiptSha256,
    sourceSnapshotBindingSha256: backup.manifest.state.snapshotBindingSha256,
    expectedSourceOverallStateSha256: overallStateSha256,
    restoredOverallStateSha256: overallStateSha256,
    ledgerCurrentSha256: "7".repeat(64),
    ledgerGenesisSha256: "8".repeat(64),
    ledgerCheckpointSha256: "9".repeat(64),
    ledgerImmutableSetSha256: "a".repeat(64),
    ledgerTombstoneCount: 2,
    counts: {
      seen: 2,
      newlyApplied: first ? 2 : 0,
      alreadyApplied: first ? 0 : 2,
      missing: 0,
      failed: 0,
    },
    recipientSecretPhysicalCheckpointVerified: true,
    semanticProjectionSha256: "9".repeat(64),
    idempotency: "exact-semantic-projection",
  });
  write(directory, "deletion-replay-first-receipt.json", replay(true));
  write(directory, "deletion-replay-second-receipt.json", replay(false));
  write(
    directory,
    "recovered-smoke-receipt.json",
    withReceiptHash({
      schemaVersion: 1,
      kind: "pintpath-recovered-postgres-application-smoke",
      status: "verified",
      ok: true,
      candidateSha: candidate,
      targetIdentitySha256: targetDatabaseIdentitySha256,
      applicationReadyAt: "2026-01-01T00:14:30.000Z",
      completedAt: "2026-01-01T00:14:40.000Z",
      checkedAt: "2026-01-01T00:14:40.000Z",
      firstReplayReceiptSha256: sha(
        fs.readFileSync(
          path.join(directory, "deletion-replay-first-receipt.json"),
        ),
      ),
      semanticProjectionSha256: "9".repeat(64),
      tombstoneCount: 2,
      secondReplayReceiptSha256: sha(
        fs.readFileSync(
          path.join(directory, "deletion-replay-second-receipt.json"),
        ),
      ),
      compiledArtifactSha256: "a".repeat(64),
      compiledEntrypointSha256: "b".repeat(64),
      compiledArtifactExact: true,
      runtimeDependencyBoundaryExact: true,
      runtimeDependencyArtifactSha256: "5".repeat(64),
      runtimeDependencyPackageLockSha256: "6".repeat(64),
      runtimeDependencyPackageCount: 10,
      runtimeDependencyFileCount: 100,
      runtimeDependencyBytes: 10_000,
      candidateArtifactBindingExact: true,
      runtimeRoleExact: true,
      maintenanceRoleRestricted: true,
      applicationStateReady: true,
      deletionPrivacyReconciled: true,
      compiledApplicationStarted: true,
      startupProbeExact: true,
      startupRouteReady: true,
      readyProbeExact: true,
      readyRouteReady: true,
      authenticatedBoundaryExact: true,
      authenticatedRuntimeExact: true,
      authSubjectSha256: "c".repeat(64),
      authEmailSha256: "d".repeat(64),
      supabaseOriginSha256: targetSupabaseOriginSha256,
      supabasePublishableKeySha256: "e".repeat(64),
      disposableSupabaseCredentialExact: true,
      restoredAuthAccountPreexistingExact: true,
      noAdminOrVenueElevationExact: true,
      adminBoundaryDeniedExact: true,
      deletionMutationDeniedExact: true,
      noPrivateDataLeakageExact: true,
      crossProjectTokenRejectedLocally: true,
      crossProjectTokenRejectedLocallyExact: true,
      crossProjectTokenParserRejectedLocallyExact: true,
      appSessionRevokedExact: true,
      providerSessionLogoutExact: true,
      automaticMaintenanceWorkersExternalWritesDisabledExact: true,
      automaticStartupMaintenanceWorkersExternalWritesDisabledExact: true,
      runtimeMaintenanceUrlsDistinctExact: true,
      disposableRailwayIdentityExact: true,
      disposableSupabaseIdentityExact: true,
      disposableRedisIdentityExact: true,
      productionPermanentStagingReuseRejectedExact: true,
      childOutputBoundedRedactedExact: true,
      childTerminatedExact: true,
      applicationChildTerminated: true,
      databaseAuthoritiesClosedExact: true,
      transportClosedExact: true,
      runtimeDatabaseUrlSha256: "1".repeat(64),
      maintenanceDatabaseUrlSha256: targetConnectionUrlSha256,
      redisUrlSha256: "3".repeat(64),
      transportProfile: "railway-stock-localhost-ca-v1",
      transportRootCaDerSha256,
    }),
  );
  const purgeReceipt = write(
    directory,
    "storage-purge-receipt.json",
    withReceiptHash({
      schemaVersion: 1,
      kind: "pintpath-postgres-private-storage-recovery-target-purge",
      ok: true,
      candidateSha: candidate,
      completedAt: "2026-01-01T00:14:45.000Z",
      destinationProjectRefSha256: sha(targetSupabaseProjectRef),
      targetRailwayProjectIdSha256: sha(targetProjectId),
      targetRailwayEnvironmentIdSha256: sha(targetEnvironmentId),
      targetDatabaseIdentitySha256,
      targetConnectionUrlSha256,
      destinationOriginSha256: targetSupabaseOriginSha256,
      bucketNameSha256: sha("beermap-source-evidence"),
      destinationRestoreAuthoritySha256: "5".repeat(64),
      purgeAuthoritySha256: "8".repeat(64),
      purgeAuthorityPublicKeySha256: "9".repeat(64),
      purgeAuthorityReviewerIdSha256: "a".repeat(64),
      recoverySetSha256,
      recoveryManifestSha256,
      restoreReceiptSha256: sha(privateRestore),
      restoredObjectSetSha256: recoveryManifestWithoutBinding.sourceStorage.objectSetSha256,
      removedObjectCount: 1,
      bucketPrivateExact: true,
      restoredObjectSetExact: true,
      concurrentObjectSetAbsent: true,
      storageObjectsAbsentExact: true,
    }),
  );
  const railwayReceipt = withReceiptHash({
    schemaVersion: 1,
    kind: "pintpath-production-recovery-railway-teardown",
    ok: true,
    outcome: "deleted",
    completedAt: "2026-01-01T00:14:50.000Z",
    candidateSha: candidate,
    observedCleanupRunId: runId,
    signedActivationRunId: runId,
    cleanupWorkflowPath: ".github/workflows/activate-production-promotion-recovery.yml",
    projectId: targetProjectId,
    projectName: "pintpath-disposable-restore-fixture",
    environmentId: targetEnvironmentId,
    environmentName: "production",
    expectedInventorySha256: "b".repeat(64),
    workspaceId: "33333333-3333-4333-8333-333333333333",
    workspaceName: "Pint Path",
    expectedWorkspaceProjectInventorySha256: "2".repeat(64),
    emergencyCleanupArmAuthoritySha256: "3".repeat(64),
    policySha256: "4d1c22a4d5779f9383e133a1da8cfa40d10a6317343298210efc81e4f18403ef",
    teardownAuthoritySha256: "c".repeat(64),
    teardownAuthorityPublicKeySha256: "d".repeat(64),
    teardownAuthorityReviewerIdSha256: "e".repeat(64),
    intentSha256: "f".repeat(64),
    preflightInventorySha256: "0".repeat(64),
    postflightInventorySha256: "1".repeat(64),
    preflightWorkspaceProjectInventorySha256: "4".repeat(64),
    postflightWorkspaceProjectInventorySha256: "5".repeat(64),
    deleteAttempts: 1,
    retryAllowed: false,
    checks: {
      policyExact: true,
      githubAuthorityExact: true,
      targetNotProtected: true,
      signedAuthorityExact: true,
      credentialsSeparatedExact: true,
      metadataAuthoritiesAgree: true,
      completeInventoryExact: true,
      signedServiceInventoryExact: true,
      workspaceAuthoritiesExact: true,
      completeWorkspaceInventoryExact: true,
      signedWorkspaceInventoryExact: true,
      durableIntentExact: true,
      deleteAttemptedAtMostOnce: true,
      acknowledgementExact: true,
      postflightAttempted: true,
      targetAbsentExact: true,
      terminalEvidenceExact: true,
    },
  });
  write(directory, "railway-teardown-terminal.json", {
    schemaVersion: "pintpath-production-recovery-railway-teardown-terminal/v1",
    receipt: railwayReceipt,
  });
  const supabaseReceipt = withReceiptHash({
    schemaVersion: 1,
    kind: "pintpath-protected-disposable-supabase-project-teardown",
    ok: true,
    outcome: "deleted",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    completedAt: "2026-01-01T00:14:55.000Z",
    candidateSha: candidate,
    observedCleanupRunId: runId,
    signedActivationRunId: runId,
    cleanupWorkflowPath: ".github/workflows/activate-production-promotion-recovery.yml",
    projectRef: targetSupabaseProjectRef,
    projectName: "pintpath-disposable-restore-fixture",
    organizationSlugSha256: "2".repeat(64),
    cleanupMode: "orderly",
    purgeReceiptSha256: sha(purgeReceipt),
    destinationOriginSha256: targetSupabaseOriginSha256,
    targetRailwayProjectId: targetProjectId,
    targetRailwayEnvironmentId: targetEnvironmentId,
    destinationRestoreAuthoritySha256: "5".repeat(64),
    emergencyCleanupArmAuthoritySha256: "9".repeat(64),
    policySha256: "fd3a45234a02ba3df8fadb6e2f36d1070a72be75eec792986f85abd74e5f6796",
    teardownAuthoritySha256: "3".repeat(64),
    teardownAuthorityPublicKeySha256: "4".repeat(64),
    teardownAuthorityReviewerIdSha256: "5".repeat(64),
    intentSha256: "6".repeat(64),
    preflightInventorySha256: "7".repeat(64),
    postflightInventorySha256: "8".repeat(64),
    deleteAttempts: 1,
    retryAllowed: false,
    checks: {
      policyExact: true,
      githubAuthorityExact: true,
      targetNotProtected: true,
      orderlyPurgeEvidenceExactOrNotRequired: true,
      signedAuthorityExact: true,
      credentialsSeparatedExact: true,
      preflightInventoryExact: true,
      targetMetadataExact: true,
      durableIntentExact: true,
      deleteAttemptedAtMostOnce: true,
      acknowledgementExact: true,
      postflightAttempted: true,
      targetAbsentExact: true,
      terminalEvidenceExact: true,
    },
  });
  write(directory, "supabase-teardown-terminal.json", {
    schemaVersion:
      "pintpath-protected-disposable-supabase-project-teardown-terminal/v1",
    receipt: supabaseReceipt,
  });
}

function writeStaticGithubAuthority(directory: string): string {
  const filename = path.join(directory, "activation-github-authority.json");
  write(directory, path.basename(filename), {
    schemaVersion: 1,
    kind: "pintpath-production-promotion-recovery-activation-github-authority",
    repository: "blackmagic30/Beer",
    candidateSha,
    workflowPath:
      ".github/workflows/activate-production-promotion-recovery.yml",
    workflowRunId: runId,
    workflowRunAttempt: 1,
    workflowRunStartedAt: "2026-01-01T00:04:00.000Z",
    workflowEvent: "workflow_dispatch",
    workflowConclusion: "success",
    artifactName: `pintpath-production-promotion-recovery-activation-${candidateSha}`,
    artifactId: "987654321",
    artifactDigest: `sha256:${"b".repeat(64)}`,
    artifactSizeBytes: 12345,
    artifactExpired: false,
  });
  return filename;
}

function completeActivation(directory: string): string {
  makeEvidence(directory);
  createProductionPromotionRecoveryActivationReceipt(
    activationArgs(directory),
    {
      now: () => new Date("2026-01-01T00:15:00.000Z"),
    },
  );
  write(directory, "tested-commit-sha.txt", `${candidateSha}\n`);
  const authorityDirectory = tempDirectory("activation-authority");
  return writeStaticGithubAuthority(authorityDirectory);
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("production promotion recovery activation receipts", () => {
  it("creates and verifies the exact 18-leaf, self-hashed activation", () => {
    const directory = tempDirectory("activation");
    const githubAuthority = completeActivation(directory);
    const receipt = verifyProductionPromotionRecoveryActivation({
      directory,
      candidateSha,
      runId,
      githubAuthority,
    });
    expect(receipt).toMatchObject({
      allOperationsExact: true,
      targetAbsent: true,
      evidence: expect.arrayContaining([
        expect.objectContaining({ leaf: "storage-purge-receipt.json" }),
        expect.objectContaining({ leaf: "railway-teardown-terminal.json" }),
        expect.objectContaining({ leaf: "supabase-teardown-terminal.json" }),
      ]),
    });
    expect(receipt.evidence as unknown[]).toHaveLength(18);
    expect(PRODUCTION_PROMOTION_RECOVERY_EXACT_SCHEMA_EVIDENCE).toEqual(
      PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_EVIDENCE,
    );
    expect(fs.readdirSync(directory)).toHaveLength(20);
  });

  it("rejects tampered evidence and bundle-A/restore-B substitution", () => {
    const directory = tempDirectory("activation-tamper");
    const githubAuthority = completeActivation(directory);
    fs.appendFileSync(
      path.join(directory, "private-storage-restore-receipt.json"),
      " ",
    );
    expect(() =>
      verifyProductionPromotionRecoveryActivation({
        directory,
        candidateSha,
        runId,
        githubAuthority,
      }),
    ).toThrow(/evidence_mismatch/);

    const substituted = tempDirectory("activation-substitution");
    makeEvidence(substituted);
    const restorePath = path.join(
      substituted,
      "private-storage-restore-receipt.json",
    );
    const restore = JSON.parse(fs.readFileSync(restorePath, "utf8")) as Record<
      string,
      unknown
    >;
    restore.recoverySetSha256 = "f".repeat(64);
    fs.writeFileSync(restorePath, canonical(restore), { mode: 0o600 });
    expect(() =>
      createProductionPromotionRecoveryActivationReceipt(
        activationArgs(substituted),
        { now: () => new Date("2026-01-01T00:15:00.000Z") },
      ),
    ).toThrow(/restore_invalid|worm_invalid/);
  });

  it("rejects noncanonical retention and a candidate-substituted recovery set", () => {
    const invalidRetention = tempDirectory("activation-retention");
    makeEvidence(invalidRetention, { retainUntil: "not-a-timestamp" });
    expect(() =>
      createProductionPromotionRecoveryActivationReceipt(
        activationArgs(invalidRetention),
      ),
    ).toThrow(/worm_invalid/);

    const wrongCandidate = tempDirectory("activation-candidate");
    makeEvidence(wrongCandidate, { candidate: "c".repeat(40) });
    expect(() =>
      createProductionPromotionRecoveryActivationReceipt(
        activationArgs(wrongCandidate),
      ),
    ).toThrow(/replay_invalid|manifest_invalid/);
  });

  it("rejects logical-WORM retrieval substitution and post-restore retrieval chronology", () => {
    const substituted = tempDirectory("activation-logical-worm-substitution");
    makeEvidence(substituted);
    const receiptPath = path.join(
      substituted,
      "logical-worm-retrieval-receipt.json",
    );
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<
      string,
      unknown
    >;
    receipt.wormResultSha256 = "f".repeat(64);
    fs.writeFileSync(receiptPath, canonical(receipt), { mode: 0o600 });
    expect(() =>
      createProductionPromotionRecoveryActivationReceipt(
        activationArgs(substituted),
      ),
    ).toThrow(/logical_worm_retrieval_invalid/);

    const late = tempDirectory("activation-logical-worm-late");
    makeEvidence(late);
    const latePath = path.join(late, "logical-worm-retrieval-receipt.json");
    const lateReceipt = JSON.parse(fs.readFileSync(latePath, "utf8")) as Record<
      string,
      unknown
    >;
    lateReceipt.retrievedAt = "2026-01-01T00:11:01.000Z";
    fs.writeFileSync(latePath, canonical(lateReceipt), { mode: 0o600 });
    expect(() =>
      createProductionPromotionRecoveryActivationReceipt(activationArgs(late)),
    ).toThrow(/logical_worm_retrieval_invalid/);
  });

  it("requires the explicitly parser-local cross-project token proof", () => {
    const directory = tempDirectory("activation-cross-project-parser");
    makeEvidence(directory);
    const smokePath = path.join(directory, "recovered-smoke-receipt.json");
    const smoke = JSON.parse(fs.readFileSync(smokePath, "utf8")) as Record<
      string,
      unknown
    >;
    delete smoke.receiptSha256;
    smoke.crossProjectTokenParserRejectedLocallyExact = false;
    fs.writeFileSync(smokePath, canonical(withReceiptHash(smoke)), {
      mode: 0o600,
    });
    expect(() =>
      createProductionPromotionRecoveryActivationReceipt(
        activationArgs(directory),
      ),
    ).toThrow(/smoke_invalid|cleanup_invalid/);
  });

  it("rejects missing, false, and extra recovered dependency proof fields", () => {
    const mutations: Array<(receipt: Record<string, unknown>) => void> = [
      (receipt) => { delete receipt.runtimeDependencyBoundaryExact; },
      (receipt) => { receipt.runtimeDependencyBoundaryExact = false; },
      (receipt) => { delete receipt.runtimeDependencyArtifactSha256; },
      (receipt) => { receipt.unexpectedDependencyProof = true; },
    ];
    mutations.forEach((mutate, index) => {
      const directory = tempDirectory(`activation-runtime-dependency-${index}`);
      makeEvidence(directory);
      const smokePath = path.join(directory, "recovered-smoke-receipt.json");
      const smoke = JSON.parse(fs.readFileSync(smokePath, "utf8")) as Record<
        string,
        unknown
      >;
      delete smoke.receiptSha256;
      mutate(smoke);
      fs.writeFileSync(smokePath, canonical(withReceiptHash(smoke)), { mode: 0o600 });
      expect(() => createProductionPromotionRecoveryActivationReceipt(
        activationArgs(directory),
      )).toThrow(/smoke_invalid/);
    });
  });

  it("rejects missing, extra, and changed WORM and cleanup contract fields", () => {
    const cases = [
      {
        leaf: "private-storage-worm-receipt.json",
        mutate: (value: Record<string, unknown>) => { delete value.receiptObjectKeySha256; },
      },
      {
        leaf: "private-storage-worm-receipt.json",
        mutate: (value: Record<string, unknown>) => { value.unexpected = true; },
      },
      {
        leaf: "private-storage-worm-retrieval-receipt.json",
        mutate: (value: Record<string, unknown>) => {
          value.wormResultSha256 = "f".repeat(64);
        },
      },
      {
        leaf: "storage-purge-receipt.json",
        mutate: (value: Record<string, unknown>) => {
          delete value.receiptSha256;
          delete value.bucketNameSha256;
          Object.assign(value, withReceiptHash(value));
        },
      },
      {
        leaf: "railway-teardown-terminal.json",
        mutate: (value: Record<string, unknown>) => {
          const receipt = value.receipt as Record<string, unknown>;
          delete receipt.receiptSha256;
          (receipt.checks as Record<string, unknown>).unexpected = true;
          Object.assign(receipt, withReceiptHash(receipt));
        },
      },
      {
        leaf: "railway-teardown-terminal.json",
        mutate: (value: Record<string, unknown>) => {
          const receipt = value.receipt as Record<string, unknown>;
          delete receipt.receiptSha256;
          receipt.signedActivationRunId = "987654321";
          Object.assign(receipt, withReceiptHash(receipt));
        },
      },
      {
        leaf: "supabase-teardown-terminal.json",
        mutate: (value: Record<string, unknown>) => {
          const receipt = value.receipt as Record<string, unknown>;
          delete receipt.receiptSha256;
          delete receipt.policySha256;
          Object.assign(receipt, withReceiptHash(receipt));
        },
      },
    ];
    cases.forEach(({ leaf, mutate }, index) => {
      const directory = tempDirectory(`activation-exact-contract-${index}`);
      makeEvidence(directory);
      const filename = path.join(directory, leaf);
      const value = JSON.parse(fs.readFileSync(filename, "utf8")) as Record<string, unknown>;
      mutate(value);
      fs.writeFileSync(filename, canonical(value), { mode: 0o600 });
      expect(() => createProductionPromotionRecoveryActivationReceipt(
        activationArgs(directory),
      )).toThrow(/worm_invalid|purge_invalid|railway_invalid|supabase_invalid|cleanup_invalid/);
    });
  });

  it("leaves no green receipt after close failure, collision, or parent replacement", () => {
    const closeFailure = tempDirectory("activation-close");
    makeEvidence(closeFailure);
    expect(() =>
      createProductionPromotionRecoveryActivationReceipt(
        activationArgs(closeFailure),
        {
          holdDirectory: (directory: string) => {
            const held = holdPrivateDirectoryIdentity(directory, {
              requireExactDirectoryMode: true,
              requireOwner: true,
            });
            return {
              ...held,
              close: () => {
                held.close();
                throw new Error("close_failed");
              },
            };
          },
        },
      ),
    ).toThrow(/output_unsafe/);
    expect(
      fs.existsSync(path.join(closeFailure, "activation-receipt.json")),
    ).toBe(false);

    const collision = tempDirectory("activation-collision");
    makeEvidence(collision);
    write(collision, "activation-receipt.json", "occupied\n");
    expect(() =>
      createProductionPromotionRecoveryActivationReceipt(
        activationArgs(collision),
      ),
    ).toThrow(/private_output_invalid/);

    const replacement = tempDirectory("activation-replacement");
    makeEvidence(replacement);
    const moved = `${replacement}.original`;
    roots.push(moved);
    expect(() =>
      createProductionPromotionRecoveryActivationReceipt(
        activationArgs(replacement),
        {
          writeFile: (
            parent: string,
            leaf: string,
            source: string,
            identity: object,
          ) => {
            fs.renameSync(parent, moved);
            fs.mkdirSync(parent, { mode: 0o700 });
            writePrivateExclusiveFile(parent, leaf, source, {
              requireExactDirectoryMode: true,
              requireOwner: true,
              expectedDirectoryIdentity: identity as never,
            });
          },
        },
      ),
    ).toThrow(/private_output_invalid/);
    expect(
      fs.existsSync(path.join(replacement, "activation-receipt.json")),
    ).toBe(false);
  });

  it("fails verification when either held evidence directory cannot close cleanly", () => {
    const directory = tempDirectory("activation-verify-close");
    const githubAuthority = completeActivation(directory);
    expect(() =>
      verifyProductionPromotionRecoveryActivation(
        {
          directory,
          candidateSha,
          runId,
          githubAuthority,
        },
        {
          holdDirectory: (heldPath: string) => {
            const held = holdPrivateDirectoryIdentity(heldPath, {
              requireExactDirectoryMode: true,
              requireOwner: true,
            });
            return {
              ...held,
              close: () => {
                held.close();
                throw new Error("close_failed");
              },
            };
          },
        },
      ),
    ).toThrow(/directory_unsafe/);
  });
});

describe("GitHub activation producer authority", () => {
  const env = {
    GITHUB_REPOSITORY: "blackmagic30/Beer",
    GITHUB_TOKEN: "test-token-never-logged", // security-scan allow: synthetic GitHub authority fixture
    GITHUB_API_URL: "https://api.github.com",
  };
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith(`/actions/runs/${runId}`))
      return new Response(
        JSON.stringify({
          id: Number(runId),
          repository: { full_name: "blackmagic30/Beer" },
          path: ".github/workflows/activate-production-promotion-recovery.yml",
          event: "workflow_dispatch",
          head_sha: candidateSha,
          head_branch: "main",
          status: "completed",
          conclusion: "success",
          run_attempt: 1,
          run_started_at: "2026-01-01T00:04:00Z",
        }),
      );
    return new Response(
      JSON.stringify({
        total_count: 1,
        artifacts: [
          {
            id: 987654321,
            name: `pintpath-production-promotion-recovery-activation-${candidateSha}`,
            expired: false,
            digest: `sha256:${"b".repeat(64)}`,
            size_in_bytes: 12345,
            workflow_run: { id: Number(runId), head_sha: candidateSha },
          },
        ],
      }),
    );
  };

  it("writes one exact same-run artifact authority through held custody", async () => {
    const directory = tempDirectory("github-authority");
    const output = path.join(directory, "activation-github-authority.json");
    await writeGithubAuthority(
      ["--candidate-sha", candidateSha, "--run-id", runId, "--output", output],
      env,
      fetchImpl as typeof fetch,
    );
    const authority = JSON.parse(fs.readFileSync(output, "utf8")) as Record<
      string,
      unknown
    >;
    expect(authority).toMatchObject({
      workflowRunId: runId,
      candidateSha,
      artifactId: "987654321",
      artifactDigest: `sha256:${"b".repeat(64)}`,
    });
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
  });

  it("filters a multi-artifact activation run to the one exact final artifact", async () => {
    const directory = tempDirectory("github-multi-artifact-authority");
    const output = path.join(directory, "activation-github-authority.json");
    const requestedUrls: string[] = [];
    const filteredFetch = async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith(`/actions/runs/${runId}`)) {
        return new Response(
          JSON.stringify({
            id: Number(runId),
            repository: { full_name: "blackmagic30/Beer" },
            path: ".github/workflows/activate-production-promotion-recovery.yml",
            event: "workflow_dispatch",
            head_sha: candidateSha,
            head_branch: "main",
            status: "completed",
            conclusion: "success",
            run_attempt: 1,
            run_started_at: "2026-01-01T00:04:00Z",
          }),
        );
      }
      expect(url).toBe(
        `https://api.github.com/repos/blackmagic30/Beer/actions/runs/${runId}/artifacts` +
          `?name=pintpath-production-promotion-recovery-activation-${candidateSha}`,
      );
      return new Response(
        JSON.stringify({
          total_count: 1,
          artifacts: [
            {
              id: 987654321,
              name: `pintpath-production-promotion-recovery-activation-${candidateSha}`,
              expired: false,
              digest: `sha256:${"b".repeat(64)}`,
              size_in_bytes: 12345,
              workflow_run: { id: Number(runId), head_sha: candidateSha },
            },
          ],
        }),
      );
    };
    await writeGithubAuthority(
      ["--candidate-sha", candidateSha, "--run-id", runId, "--output", output],
      env,
      filteredFetch as typeof fetch,
    );
    expect(requestedUrls).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({
      artifactName: `pintpath-production-promotion-recovery-activation-${candidateSha}`,
      artifactId: "987654321",
    });
  });

  it("rejects cross-run metadata and output collisions", async () => {
    const directory = tempDirectory("github-invalid");
    const output = path.join(directory, "activation-github-authority.json");
    const crossRun = async () =>
      new Response(
        JSON.stringify({
          id: 55,
          repository: { full_name: "blackmagic30/Beer" },
        }),
      );
    await expect(
      writeGithubAuthority(
        [
          "--candidate-sha",
          candidateSha,
          "--run-id",
          runId,
          "--output",
          output,
        ],
        env,
        crossRun as typeof fetch,
      ),
    ).rejects.toThrow(/run_invalid/);
    write(directory, path.basename(output), "occupied\n");
    await expect(
      writeGithubAuthority(
        [
          "--candidate-sha",
          candidateSha,
          "--run-id",
          runId,
          "--output",
          output,
        ],
        env,
        fetchImpl as typeof fetch,
      ),
    ).rejects.toThrow(/output_collision/);
  });

  it("cancels a GitHub response whose declared body exceeds the cap", async () => {
    const directory = tempDirectory("github-response-cap");
    const output = path.join(directory, "activation-github-authority.json");
    let cancelled = 0;
    const oversizedFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel: () => {
            cancelled += 1;
          },
        }),
        {
          status: 200,
          headers: { "content-length": String(8 * 1024 * 1024 + 1) },
        },
      );
    await expect(
      writeGithubAuthority(
        [
          "--candidate-sha",
          candidateSha,
          "--run-id",
          runId,
          "--output",
          output,
        ],
        env,
        oversizedFetch as typeof fetch,
      ),
    ).rejects.toThrow(/api_failed/);
    await Promise.resolve();
    expect(cancelled).toBe(1);
    expect(fs.existsSync(output)).toBe(false);
  });

  it("cancels an undeclared streamed GitHub body when it crosses the cap", async () => {
    const directory = tempDirectory("github-stream-cap");
    const output = path.join(directory, "activation-github-authority.json");
    let cancelled = 0;
    let pulls = 0;
    const oversizedFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: (controller) => {
            pulls += 1;
            controller.enqueue(
              new Uint8Array(pulls === 1 ? 8 * 1024 * 1024 : 1),
            );
          },
          cancel: () => {
            cancelled += 1;
          },
        }),
        { status: 200 },
      );
    await expect(
      writeGithubAuthority(
        [
          "--candidate-sha",
          candidateSha,
          "--run-id",
          runId,
          "--output",
          output,
        ],
        env,
        oversizedFetch as typeof fetch,
      ),
    ).rejects.toThrow(/api_failed/);
    expect(pulls).toBeGreaterThanOrEqual(2);
    expect(cancelled).toBe(1);
    expect(fs.existsSync(output)).toBe(false);
  });

  it("uses the GitHub request deadline to cancel a stalled streamed body", async () => {
    const directory = tempDirectory("github-response-stall");
    const output = path.join(directory, "activation-github-authority.json");
    let cancelled = 0;
    const stalledFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
          cancel: () => {
            cancelled += 1;
          },
        }),
        { status: 200 },
      );
    const startedAt = Date.now();
    await expect(
      writeGithubAuthority(
        [
          "--candidate-sha",
          candidateSha,
          "--run-id",
          runId,
          "--output",
          output,
        ],
        env,
        stalledFetch as typeof fetch,
        { requestTimeoutMs: 15 },
      ),
    ).rejects.toThrow(/api_failed/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(cancelled).toBe(1);
    expect(fs.existsSync(output)).toBe(false);
  });

  it("leaves no authority after close failure or output-parent replacement", async () => {
    const closeFailure = tempDirectory("github-close");
    const closeOutput = path.join(
      closeFailure,
      "activation-github-authority.json",
    );
    await expect(
      writeGithubAuthority(
        [
          "--candidate-sha",
          candidateSha,
          "--run-id",
          runId,
          "--output",
          closeOutput,
        ],
        env,
        fetchImpl as typeof fetch,
        {
          holdDirectory: (directory: string) => {
            const held = holdPrivateDirectoryIdentity(directory, {
              requireExactDirectoryMode: true,
              requireOwner: true,
            });
            return {
              ...held,
              close: () => {
                held.close();
                throw new Error("close_failed");
              },
            };
          },
        },
      ),
    ).rejects.toThrow(/output_unsafe/);
    expect(fs.existsSync(closeOutput)).toBe(false);

    const replacement = tempDirectory("github-replacement");
    const replacementOutput = path.join(
      replacement,
      "activation-github-authority.json",
    );
    const moved = `${replacement}.original`;
    roots.push(moved);
    await expect(
      writeGithubAuthority(
        [
          "--candidate-sha",
          candidateSha,
          "--run-id",
          runId,
          "--output",
          replacementOutput,
        ],
        env,
        fetchImpl as typeof fetch,
        {
          writeFile: (
            parent: string,
            leaf: string,
            source: string,
            identity: object,
          ) => {
            fs.renameSync(parent, moved);
            fs.mkdirSync(parent, { mode: 0o700 });
            writePrivateExclusiveFile(parent, leaf, source, {
              requireExactDirectoryMode: true,
              requireOwner: true,
              expectedDirectoryIdentity: identity as never,
            });
          },
        },
      ),
    ).rejects.toThrow(/private_output_invalid/);
    expect(fs.existsSync(replacementOutput)).toBe(false);
  });
});
