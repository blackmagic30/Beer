import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import { postgresPrivateStorageRecoveryInternals } from
  "../src/lib/postgres-private-storage-recovery.js";
import {
  sha256PostgresReviewedPriceOperationReceipt,
} from "../src/lib/postgres-reviewed-price-promotion-operation.js";
import {
  PRODUCTION_PROMOTION_RECOVERY_APPROVAL_SCHEMA,
  PRODUCTION_PROMOTION_RECOVERY_AUTHORITY_SCHEMA,
  productionRecoveryRecoveredApplicationSchema,
  sha256ProductionPromotionRecoveryBytes,
  sha256ProductionPromotionRecoveryValue,
} from "../src/lib/production-promotion-recovery.js";
import {
  PRODUCTION_PROMOTION_RECOVERY_POLICY_SHA256,
  attestProductionPromotionRecovery,
} from "../scripts/attest-production-promotion-recovery.js";
import {
  PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_EVIDENCE,
} from "../scripts/create-production-promotion-recovery-activation-receipt.mjs";
import { productionApplicationDeploymentReceiptFixture } from
  "./production-application-deployment-receipt.fixtures.js";
import { writeLogicalOffsiteFixture } from "./postgres-logical-offsite.fixtures.js";

const CANDIDATE = "c".repeat(40);
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const PRE_UPLOAD_DEPLOYMENT_ID_SHA256 = "e".repeat(64);
const UPLOAD_DEPLOYMENT_ID_SHA256 = "c".repeat(64);
const ACTIVE_DEPLOYMENT_ID_SHA256 = "d".repeat(64);
const TARGET = "1".repeat(64);
const CA_DER = "f".repeat(64);
const OPERATION = "11111111-1111-4111-8111-111111111111";
const AUTHORIZATION = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const TARGET_ENVIRONMENT_ID = "55555555-5555-4555-8555-555555555555";
const TARGET_SUPABASE_PROJECT_REF = "abcdefghijklmnopqrst";
const TARGET_SUPABASE_ORIGIN_SHA256 = sha256(
  `https://${TARGET_SUPABASE_PROJECT_REF}.supabase.co`,
);
const ACTIVATION_RUN_ID = "123456789";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function privateRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-attestor-")));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function writeJson(root: string, name: string, value: unknown): string {
  const filename = path.join(root, name);
  fs.writeFileSync(filename, canonicalPostgresBackupJson(value), { mode: 0o600 });
  fs.chmodSync(filename, 0o600);
  return filename;
}

function receiptWithHash(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    receiptSha256: sha256ProductionPromotionRecoveryValue(value),
  };
}

function replay(input: {
  readonly at: string;
  readonly baseRestoreSha256: string;
  readonly newlyApplied: number;
  readonly alreadyApplied: number;
}) {
  return {
    kind: "pintpath-postgres-account-deletion-tombstone-replay",
    version: 2,
    status: "verified",
    replayedAt: input.at,
    targetIdentitySha256: TARGET,
    targetClass: "disposable-rehearsal",
    serverVersionNum: "170010",
    replayRoleRestricted: true,
    replayEffectiveRole: "pintpath_maintenance",
    transportProfile: "railway-stock-localhost-ca-v1",
    transportRootCaDerSha256: CA_DER,
    restoreLockKeySha256: HASH,
    baseRestoreReceiptSha256: input.baseRestoreSha256,
    migrationCandidateSha: CANDIDATE,
    migrationManifestSha256: HASH,
    migrationRunSha256: HASH,
    sourceSnapshotSha256: HASH,
    backupManifestSha256: HASH,
    backupArchiveSha256: HASH,
    sourceStateReceiptSha256: HASH,
    sourceSnapshotBindingSha256: HASH,
    expectedSourceOverallStateSha256: HASH,
    restoredOverallStateSha256: HASH,
    ledgerCurrentSha256: HASH,
    ledgerGenesisSha256: HASH,
    ledgerCheckpointSha256: HASH,
    ledgerImmutableSetSha256: HASH,
    ledgerTombstoneCount: 1,
    counts: {
      seen: 1,
      newlyApplied: input.newlyApplied,
      alreadyApplied: input.alreadyApplied,
      missing: 0,
      failed: 0,
    },
    recipientSecretPhysicalCheckpointVerified: true,
    semanticProjectionSha256: OTHER_HASH,
    idempotency: "exact-semantic-projection",
  };
}

describe("production promotion-recovery attestor", () => {
  it("accepts one exact apply-only post-promotion recovery chain", async () => {
    const root = privateRoot();
    const backup = writeLogicalOffsiteFixture(root, "2026-08-14T00:05:00.000Z", 3);
    const files = new Map<string, string>();
    const put = (name: string, value: unknown) => {
      const filename = writeJson(root, `${name}.json`, value);
      files.set(name, filename);
      return filename;
    };
    const fileSha = (name: string) => sha256(fs.readFileSync(files.get(name)!));
    const deployment = productionApplicationDeploymentReceiptFixture({
      candidateSha: CANDIDATE,
      previousDeploymentIdSha256: PRE_UPLOAD_DEPLOYMENT_ID_SHA256,
      deploymentIdSha256: UPLOAD_DEPLOYMENT_ID_SHA256,
      startedAt: "2026-08-13T23:59:30.000Z",
      completedAt: "2026-08-14T00:00:00.000Z",
    });
    put("production-deployment-receipt", deployment);
    put("production-scale-receipt", {
      schemaVersion: "pintpath-permanent-staging-scale-operation/v2",
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      direction: "converge-production-two",
      outcome: "scaled",
      candidateSha: CANDIDATE,
      startedAt: "2026-08-14T00:00:30.000Z",
      completedAt: "2026-08-14T00:01:00.000Z",
      desiredReplicas: 2,
      deploymentIdSha256: ACTIVE_DEPLOYMENT_ID_SHA256,
      attempts: 1,
      retryAllowed: false,
      intentSha256: "1".repeat(64),
      terminalEvidenceSha256: "2".repeat(64),
      commandStdoutSha256: "3".repeat(64),
      commandStderrSha256: "4".repeat(64),
      productionActivationPrerequisite: {
        runId: "8000",
        verificationSha256: "5".repeat(64),
        terminalSha256: "6".repeat(64),
        prerequisitesSha256: "7".repeat(64),
        deploymentBeforeIdSha256: UPLOAD_DEPLOYMENT_ID_SHA256,
        deploymentAfterIdSha256: ACTIVE_DEPLOYMENT_ID_SHA256,
      },
      checks: {
        policyExact: true,
        githubAuthorityExact: true,
        tokenScopesExact: true,
        cliExact: true,
        boundaryPreflightExact: true,
        targetPreflightExact: true,
        productionActivationPrerequisiteExact: true,
        productionActivationDeploymentContinuityExact: true,
        runtimePreflightExact: true,
        durableIntentExact: true,
        repositoryPrewriteReasserted: true,
        writeAttemptedAtMostOnce: true,
        acknowledgementExact: true,
        postflightAttempted: true,
        targetPostflightExact: true,
        runtimePostflightExact: true,
        candidateUnchanged: true,
        deploymentUnchanged: true,
        boundaryPostflightExact: true,
        terminalEvidenceExact: true,
        finalReceiptEvidenceExact: true,
      },
    });
    const provisionalClose = {
      schemaVersion: "pintpath-protected-production-route-mutation/v1",
      operation: "close",
      candidateSha: CANDIDATE,
      deploymentIdSha256: ACTIVE_DEPLOYMENT_ID_SHA256,
      terminalEvidenceSha256: null,
      checks: { terminalEvidenceExact: false, finalReceiptEvidenceExact: false },
    };
    const terminal = {
      schemaVersion: "pintpath-protected-production-route-terminal/v1",
      receipt: provisionalClose,
    };
    const terminalFile = put("closed-route-terminal", terminal);
    const closeChecks = {
      policyExact: true,
      githubAuthorityExact: true,
      repositoryAuthorityExact: true,
      predecessorAuthorityExact: true,
      predecessorReceiptsExact: true,
      promotionRecoveryAuthorityExact: true,
      credentialsExact: true,
      tokenScopesExact: true,
      patchPreflightEmpty: true,
      inventoryPreflightExact: true,
      candidateDeploymentPreflightExact: true,
      boundaryPreflightExact: true,
      durableIntentExact: true,
      repositoryPrewriteReasserted: true,
      providerPrewriteReasserted: true,
      writeAttemptedAtMostOnce: true,
      acknowledgementExact: true,
      postflightAttempted: true,
      patchPostflightEmpty: true,
      inventoryTransitionExact: true,
      candidateDeploymentPostflightExact: true,
      boundaryPostflightExact: true,
      publicRuntimePostflightExact: false,
      terminalEvidenceExact: true,
      finalReceiptEvidenceExact: true,
    };
    put("closed-route-receipt", {
      schemaVersion: "pintpath-protected-production-route-mutation/v1",
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      outcome: "closed",
      operation: "close",
      candidateSha: CANDIDATE,
      completedAt: "2026-08-14T00:02:00.000Z",
      githubEnvironment: "production-route-close",
      deploymentIdSha256: ACTIVE_DEPLOYMENT_ID_SHA256,
      closedRouteArtifactDigest: null,
      promotionRecoveryArtifactDigest: null,
      promotionRecoveryReceiptSha256: null,
      productionDeploymentReceiptSha256: sha256(fs.readFileSync(files.get(
        "production-deployment-receipt",
      )!)),
      productionScaleReceiptSha256: sha256(fs.readFileSync(files.get(
        "production-scale-receipt",
      )!)),
      closedRouteReceiptSha256: null,
      attempts: 1,
      retryAllowed: false,
      terminalEvidenceSha256: sha256(fs.readFileSync(terminalFile)),
      checks: closeChecks,
    });
    const authorization = {
      approvalFileSha256: HASH,
      approvalPayloadSha256: HASH,
      authorizationId: AUTHORIZATION,
      authorizedAt: "2026-08-14T00:03:00.000Z",
      kind: "pintpath-postgres-reviewed-price-operation-authorization-receipt",
      operationId: OPERATION,
      operationKind: "apply",
      reviewerIdSha256: OTHER_HASH,
      version: 1,
    };
    put("apply-authorization-receipt", authorization);
    const applyWithoutHash = {
      approvalFileSha256: HASH,
      approvalReferenceSha256: HASH,
      authorizationId: AUTHORIZATION,
      authorityBundleSha256: HASH,
      candidateSha: CANDIDATE,
      committedAt: "2026-08-14T00:04:00.000Z",
      expectedEnvironment: "production" as const,
      itemCount: 1,
      kind: "pintpath-postgres-reviewed-price-operation-receipt" as const,
      operationId: OPERATION,
      operationKind: "apply" as const,
      operatorIdSha256: HASH,
      planCandidateSha256: HASH,
      requestSha256: HASH,
      requestedRowCount: 1,
      resultStateSha256: HASH,
      reviewPacketCandidateSha256: HASH,
      reviewerIdSha256: OTHER_HASH,
      sourceApplyOperationId: null,
      sourceIngestionIds: [SOURCE_ID],
      targetPhysicalIdentitySha256: backup.manifest.state.sourceDatabaseIdentitySha256,
      version: 1 as const,
    };
    put("apply-operation-receipt", {
      ...applyWithoutHash,
      receiptSha256: sha256PostgresReviewedPriceOperationReceipt(applyWithoutHash),
    });
    const pitrWithoutHash = {
      schemaVersion: "pintpath-production-post-promotion-pitr-observation/v1",
      outcome: "verified",
      candidateSha: CANDIDATE,
      productionDeploymentIdSha256: ACTIVE_DEPLOYMENT_ID_SHA256,
      recoveryPointAt: "2026-08-14T00:05:00.000Z",
      observedAt: "2026-08-14T00:06:00.000Z",
      pitrEnabledAt: "2026-08-13T23:55:00.000Z",
      projectIdSha256: HASH,
      environmentIdSha256: HASH,
      rootServiceIdSha256: HASH,
      pitrWorkflowIdSha256: HASH,
      providerHealthSha256: HASH,
      pitrEnabled: true,
      clusterHealthy: true,
    };
    put("pitr-receipt", {
      ...pitrWithoutHash,
      receiptSha256: sha256ProductionPromotionRecoveryValue(pitrWithoutHash),
    });
    files.set("logical-backup-manifest", path.join(backup.backupDirectory, "manifest.json"));
    const logicalBackupIdSha256 = sha256(
      `${backup.manifest.createdAt.replace(/[-:.]/g, "")}-${backup.manifestSha256}`,
    );
    const remoteObjectSetSha256 = "0".repeat(64);
    const attestationSha256 = "1".repeat(64);
    const latestPointerSha256 = "2".repeat(64);
    put("logical-offsite-result", {
      schemaVersion: 1,
      ok: true,
      backupCreatedAt: backup.manifest.createdAt,
      manifestSha256: backup.manifestSha256,
      archiveSha256: backup.archiveSha256,
      stateReceiptSha256: backup.receiptSha256,
      sourceDatabaseIdentitySha256: backup.manifest.state.sourceDatabaseIdentitySha256,
      overallStateSha256: backup.manifest.state.overallStateSha256,
      remoteObjectSetSha256,
      attestationSha256,
      latestPointerSha256,
      backupIdSha256: logicalBackupIdSha256,
      successStateSha256: HASH,
      completedAt: "2026-08-14T00:08:00.000Z",
    });
    const logicalImmutableObjectSetSha256 = "3".repeat(64);
    const logicalRecoveryAccountIdSha256 = "4".repeat(64);
    const logicalBucketNameSha256 = "5".repeat(64);
    const logicalReaderPrincipalSha256 = OTHER_HASH;
    const logicalWormReceiptSha256 = "6".repeat(64);
    const logicalMinimumRetainUntil = "2033-08-14T00:09:00.000Z";
    const logicalWormFile = put("logical-worm-result", {
      schemaVersion: 1,
      ok: true,
      backupCreatedAt: backup.manifest.createdAt,
      manifestSha256: backup.manifestSha256,
      archiveSha256: backup.archiveSha256,
      stateReceiptSha256: backup.receiptSha256,
      overallStateSha256: backup.manifest.state.overallStateSha256,
      backupIdSha256: logicalBackupIdSha256,
      recoveryAccountIdSha256: logicalRecoveryAccountIdSha256,
      bucketNameSha256: logicalBucketNameSha256,
      writerPrincipalArnSha256: HASH,
      readerPrincipalArnSha256: logicalReaderPrincipalSha256,
      immutableObjectSetSha256: logicalImmutableObjectSetSha256,
      writerDenialSetSha256: "7".repeat(64),
      receiptSha256: logicalWormReceiptSha256,
      receiptObjectKeySha256: "8".repeat(64),
      receiptVersionIdSha256: "9".repeat(64),
      receiptDenialSetSha256: "0".repeat(64),
      minimumRetainUntil: logicalMinimumRetainUntil,
      completedAt: "2026-08-14T00:09:00.000Z",
    });
    const logicalManifestBytes = fs.readFileSync(
      path.join(backup.backupDirectory, "manifest.json"),
    ).length;
    const logicalStateReceiptBytes = fs.readFileSync(
      path.join(backup.backupDirectory, "state-receipt.json"),
    ).length;
    const logicalLocalArtifacts = [
      { filename: "pintpath-postgres.dump", bytes: backup.manifest.archive.bytes,
        sha256: backup.archiveSha256 },
      { filename: "manifest.json", bytes: logicalManifestBytes,
        sha256: backup.manifestSha256 },
      { filename: "state-receipt.json", bytes: logicalStateReceiptBytes,
        sha256: backup.receiptSha256 },
    ];
    put("logical-worm-retrieval-receipt", {
      schemaVersion: 1,
      kind: "pintpath-postgres-logical-worm-retrieval",
      ok: true,
      retrievedAt: "2026-08-14T00:10:30.000Z",
      backupCreatedAt: backup.manifest.createdAt,
      archiveSha256: backup.archiveSha256,
      manifestSha256: backup.manifestSha256,
      stateReceiptSha256: backup.receiptSha256,
      sourceDatabaseIdentitySha256: backup.manifest.state.sourceDatabaseIdentitySha256,
      overallStateSha256: backup.manifest.state.overallStateSha256,
      backupIdSha256: logicalBackupIdSha256,
      wormResultSha256: sha256(fs.readFileSync(logicalWormFile)),
      wormReceiptSha256: logicalWormReceiptSha256,
      immutableObjectSetSha256: logicalImmutableObjectSetSha256,
      archiveBytes: backup.manifest.archive.bytes,
      manifestBytes: logicalManifestBytes,
      stateReceiptBytes: logicalStateReceiptBytes,
      localArtifactSetSha256: sha256ProductionPromotionRecoveryValue(logicalLocalArtifacts),
      recoveryAccountIdSha256: logicalRecoveryAccountIdSha256,
      bucketNameSha256: logicalBucketNameSha256,
      readerPrincipalArnSha256: logicalReaderPrincipalSha256,
      minimumRetainUntil: logicalMinimumRetainUntil,
    });
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
      capturedAt: "2026-08-14T00:07:00.000Z",
      logicalBackup: {
        manifestSha256: backup.manifestSha256,
        archiveSha256: backup.archiveSha256,
        stateReceiptSha256: backup.receiptSha256,
        sourceDatabaseIdentitySha256: backup.manifest.state.sourceDatabaseIdentitySha256,
        sourceUrlSha256: backup.manifest.state.sourceUrlSha256,
        captureUrlSha256: OTHER_HASH,
        migrationRunSha256: HASH,
        sourceEnvironment: "production" as const,
        candidateSha: CANDIDATE,
        overallStateSha256: backup.manifest.state.overallStateSha256,
        sourceEvidenceTableSha256: "4".repeat(64),
      },
      sourceStorage: {
        originSha256: sha256("https://jxpubqlmqnnqwadmjgyk.supabase.co"),
        bucketNameSha256: sha256("beermap-source-evidence"),
        objectCount: 1,
        databaseReferenceCount: 1,
        orphanObjectCount: 0,
        totalBytes: "4",
        sourceInventorySha256: sha256ProductionPromotionRecoveryValue(
          recoveryObjects.map((object) => ({
            objectPath: object.objectPath,
            bytes: object.bytes,
            contentType: object.contentType,
            storageObjectIdSha256: object.sourceStorageObjectIdSha256,
            storageVersionSha256: object.sourceStorageVersionSha256,
          })),
        ),
        objectSetSha256: sha256ProductionPromotionRecoveryValue(recoveryObjects),
        objects: recoveryObjects,
      },
      deletionAuthority: {
        currentSha256: HASH,
        genesisSha256: HASH,
        checkpointSha256: HASH,
        immutableSetSha256: HASH,
        tombstoneCount: 1,
        latestCompletedAt: "2026-08-14T00:06:30.000Z",
        authoritySetSha256: OTHER_HASH,
      },
    };
    const recoverySetSha256 = postgresPrivateStorageRecoveryInternals.recoverySetBinding(
      recoveryManifestWithoutBinding,
    );
    const recoveryManifest = {
      ...recoveryManifestWithoutBinding,
      recoverySetSha256,
    };
    const recoveryManifestFile = put("private-storage-recovery-manifest", recoveryManifest);
    put("private-storage-capture-receipt", {
      schemaVersion: 1,
      kind: "pintpath-postgres-private-storage-recovery-capture",
      ok: true,
      capturedAt: "2026-08-14T00:07:00.000Z",
      databaseTransportProfile: "railway-stock-localhost-ca-v1",
      databaseTransportRootCaDerSha256: CA_DER,
      databaseEffectiveRole: "pintpath_migrator",
      databaseConnectionUrlSha256: OTHER_HASH,
      logicalBackupManifestSha256: backup.manifestSha256,
      storageObjectCount: 1,
      databaseReferenceCount: 1,
      deletionTombstoneCount: 1,
      recoverySetSha256,
      recoveryManifestSha256: sha256(fs.readFileSync(recoveryManifestFile)),
    });
    put("offsite-retrieval-receipt", {
      schemaVersion: 1,
      kind: "pintpath-postgres-logical-offsite-retrieval",
      ok: true,
      backupCreatedAt: backup.manifest.createdAt,
      backupIdSha256: logicalBackupIdSha256,
      latestPointerSha256,
      attestationSha256,
      remoteObjectSetSha256,
      successStateSha256: HASH,
      manifestSha256: backup.manifestSha256,
      archiveSha256: backup.archiveSha256,
      stateReceiptSha256: backup.receiptSha256,
      sourceDatabaseIdentitySha256: backup.manifest.state.sourceDatabaseIdentitySha256,
      overallStateSha256: backup.manifest.state.overallStateSha256,
      archiveBytes: backup.manifest.archive.bytes,
      manifestBytes: fs.readFileSync(
        path.join(backup.backupDirectory, "manifest.json"),
      ).length,
      stateReceiptBytes: fs.readFileSync(
        path.join(backup.backupDirectory, "state-receipt.json"),
      ).length,
      localArtifactSetSha256: sha256ProductionPromotionRecoveryValue([
        { filename: "manifest.json", bytes: fs.readFileSync(
          path.join(backup.backupDirectory, "manifest.json"),
        ).length, sha256: backup.manifestSha256, mode: "0600" },
        { filename: "pintpath-postgres.dump", bytes: backup.manifest.archive.bytes,
          sha256: backup.archiveSha256, mode: "0600" },
        { filename: "state-receipt.json", bytes: fs.readFileSync(
          path.join(backup.backupDirectory, "state-receipt.json"),
        ).length, sha256: backup.receiptSha256, mode: "0600" },
      ]),
      retrievedAt: "2026-08-14T00:10:00.000Z",
    });
    const restoreFile = put("logical-restore-receipt", {
      kind: "pintpath-postgres-logical-restore",
      version: 1,
      status: "verified",
      backupManifestSha256: backup.manifestSha256,
      backupArchiveSha256: backup.archiveSha256,
      expectedSourceOverallStateSha256: backup.manifest.state.overallStateSha256,
      restoredOverallStateSha256: backup.manifest.state.overallStateSha256,
      sourceStateBindingStatus: "exact-match",
      expectedSourceStateReceiptSha256: backup.receiptSha256,
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
      exactDataReconciliation: "canonical-contract-exact",
      targetIdentitySha256: TARGET,
      targetUrlSha256: "8".repeat(64),
      authoritativeTableCount: backup.manifest.state.authoritativeTableCount,
      authoritativeColumnCount: 10,
      foreignKeyCount: 0,
      authoritativeRowCount: backup.manifest.state.authoritativeRowCount,
      nonEmptyAuthoritativeTableCount: 1,
      authoritativeCountInventorySha256: "5".repeat(64),
      controlCountInventorySha256: "6".repeat(64),
      schemaMetadataSha256: backup.manifest.state.schemaMetadataSha256,
      rowSecurityTableCount: 1,
      aclContractSha256: "7".repeat(64),
      apiRolesIsolated: true,
      runtimeApplicationAccessRestored: true,
      migratorReconciliationAccessVerified: true,
      runtimeOperationsIsolated: true,
      promotionReconciliationReady: true,
      restoredAt: "2026-08-14T00:11:00.000Z",
    });
    const privateRestoreFile = put("private-storage-restore-receipt", {
      schemaVersion: 1,
      kind: "pintpath-postgres-private-storage-recovery-restore",
      ok: true,
      candidateSha: CANDIDATE,
      restoredAt: "2026-08-14T00:12:00.000Z",
      databaseTransportProfile: "railway-stock-localhost-ca-v1",
      databaseTransportRootCaDerSha256: CA_DER,
      databaseEffectiveRole: "pintpath_migrator",
      destinationAuthoritySha256: HASH,
      destinationAuthorityPublicKeySha256: HASH,
      destinationAuthorityReviewerIdSha256: HASH,
      targetDatabaseIdentitySha256: TARGET,
      recoverySetSha256,
      recoveryManifestSha256: sha256(fs.readFileSync(recoveryManifestFile)),
      deletionAuthoritySetSha256: OTHER_HASH,
      restoredObjectCount: 1,
      restoredBytes: "4",
      destinationObjectSetSha256: recoveryManifest.sourceStorage.objectSetSha256,
      destinationConnectionUrlSha256: "8".repeat(64),
      destinationOriginSha256: TARGET_SUPABASE_ORIGIN_SHA256,
      destinationBucketNameSha256: recoveryManifest.sourceStorage.bucketNameSha256,
      destinationRailwayProjectIdSha256: sha256(TARGET_PROJECT_ID),
      destinationRailwayEnvironmentIdSha256: sha256(TARGET_ENVIRONMENT_ID),
    });
    const replayBindings = {
      migrationRunSha256: recoveryManifest.logicalBackup.migrationRunSha256,
      backupManifestSha256: backup.manifestSha256,
      backupArchiveSha256: backup.archiveSha256,
      sourceStateReceiptSha256: backup.receiptSha256,
      sourceSnapshotBindingSha256: backup.manifest.state.snapshotBindingSha256,
      expectedSourceOverallStateSha256: backup.manifest.state.overallStateSha256,
      restoredOverallStateSha256: backup.manifest.state.overallStateSha256,
    };
    put("deletion-replay-first-receipt", { ...replay({
      at: "2026-08-14T00:13:00.000Z",
      baseRestoreSha256: sha256(fs.readFileSync(restoreFile)),
      newlyApplied: 1,
      alreadyApplied: 0,
    }), ...replayBindings });
    put("deletion-replay-second-receipt", { ...replay({
      at: "2026-08-14T00:14:00.000Z",
      baseRestoreSha256: sha256(fs.readFileSync(restoreFile)),
      newlyApplied: 0,
      alreadyApplied: 1,
    }), ...replayBindings });
    const privateWormFile = put("private-storage-worm-receipt", {
      schemaVersion: 1,
      ok: true,
      kind: "pintpath-postgres-private-storage-worm-receipt",
      candidateSha: CANDIDATE,
      completedAt: "2026-08-14T00:09:30.000Z",
      minimumRetainUntil: "2033-08-14T00:09:30.000Z",
      recoverySetSha256,
      recoveryManifestSha256: fileSha("private-storage-recovery-manifest"),
      logicalBackupManifestSha256: backup.manifestSha256,
      bundleManifestSha256: "7".repeat(64),
      immutableObjectSetSha256: "9".repeat(64),
      recoveryAccountIdSha256: "0".repeat(64),
      bucketNameSha256: "1".repeat(64),
      writerPrincipalArnSha256: HASH,
      readerPrincipalArnSha256: OTHER_HASH,
      writerDenialSetSha256: "2".repeat(64),
      receiptSha256: "8".repeat(64),
      receiptObjectKeySha256: "3".repeat(64),
      receiptVersionIdSha256: "4".repeat(64),
      receiptDenialSetSha256: "5".repeat(64),
    });
    put("private-storage-worm-retrieval-receipt", {
      schemaVersion: 1,
      ok: true,
      kind: "pintpath-postgres-private-storage-worm-retrieval",
      candidateSha: CANDIDATE,
      recoveredAt: "2026-08-14T00:10:30.000Z",
      recoverySetSha256,
      recoveryManifestSha256: fileSha("private-storage-recovery-manifest"),
      logicalBackupManifestSha256: backup.manifestSha256,
      bundleManifestSha256: "7".repeat(64),
      wormResultSha256: sha256(fs.readFileSync(privateWormFile)),
      wormReceiptSha256: "8".repeat(64),
      immutableObjectSetSha256: "9".repeat(64),
      entrySetSha256: "6".repeat(64),
      recoveredBytes: "1024",
      recoveryAccountIdSha256: "0".repeat(64),
      bucketNameSha256: "1".repeat(64),
      readerPrincipalArnSha256: OTHER_HASH,
      recoveredEntryCount: 5,
      minimumRetainUntil: "2033-08-14T00:09:30.000Z",
    });
    put("recovered-smoke-receipt", receiptWithHash({
      schemaVersion: 1,
      kind: "pintpath-recovered-postgres-application-smoke",
      status: "verified",
      ok: true,
      candidateSha: CANDIDATE,
      targetIdentitySha256: TARGET,
      applicationReadyAt: "2026-08-14T00:14:30.000Z",
      completedAt: "2026-08-14T00:14:40.000Z",
      checkedAt: "2026-08-14T00:14:40.000Z",
      firstReplayReceiptSha256: fileSha("deletion-replay-first-receipt"),
      secondReplayReceiptSha256: fileSha("deletion-replay-second-receipt"),
      semanticProjectionSha256: OTHER_HASH,
      tombstoneCount: 1,
      compiledArtifactSha256: "1".repeat(64),
      compiledEntrypointSha256: "2".repeat(64),
      compiledArtifactExact: true,
      runtimeDependencyBoundaryExact: true,
      runtimeDependencyArtifactSha256: "a".repeat(64),
      runtimeDependencyPackageLockSha256: "b".repeat(64),
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
      authSubjectSha256: "3".repeat(64),
      authEmailSha256: "4".repeat(64),
      supabaseOriginSha256: TARGET_SUPABASE_ORIGIN_SHA256,
      supabasePublishableKeySha256: "5".repeat(64),
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
      runtimeDatabaseUrlSha256: "7".repeat(64),
      maintenanceDatabaseUrlSha256: "8".repeat(64),
      redisUrlSha256: "9".repeat(64),
      transportProfile: "railway-stock-localhost-ca-v1",
      transportRootCaDerSha256: CA_DER,
    }));
    const storagePurgeFile = put("storage-purge-receipt", receiptWithHash({
      schemaVersion: 1,
      kind: "pintpath-postgres-private-storage-recovery-target-purge",
      ok: true,
      candidateSha: CANDIDATE,
      completedAt: "2026-08-14T00:14:45.000Z",
      destinationProjectRefSha256: sha256(TARGET_SUPABASE_PROJECT_REF),
      targetRailwayProjectIdSha256: sha256(TARGET_PROJECT_ID),
      targetRailwayEnvironmentIdSha256: sha256(TARGET_ENVIRONMENT_ID),
      targetDatabaseIdentitySha256: TARGET,
      targetConnectionUrlSha256: "8".repeat(64),
      destinationOriginSha256: TARGET_SUPABASE_ORIGIN_SHA256,
      bucketNameSha256: sha256("beermap-source-evidence"),
      destinationRestoreAuthoritySha256: HASH,
      purgeAuthoritySha256: "0".repeat(64),
      purgeAuthorityPublicKeySha256: "1".repeat(64),
      purgeAuthorityReviewerIdSha256: "2".repeat(64),
      recoverySetSha256,
      recoveryManifestSha256: fileSha("private-storage-recovery-manifest"),
      restoreReceiptSha256: sha256(fs.readFileSync(privateRestoreFile)),
      restoredObjectSetSha256: recoveryManifest.sourceStorage.objectSetSha256,
      removedObjectCount: 1,
      bucketPrivateExact: true,
      restoredObjectSetExact: true,
      storageObjectsAbsentExact: true,
      concurrentObjectSetAbsent: true,
    }));
    const railwayTeardownReceipt = receiptWithHash({
      schemaVersion: 1,
      kind: "pintpath-production-recovery-railway-teardown",
      ok: true,
      outcome: "deleted",
      completedAt: "2026-08-14T00:14:50.000Z",
      candidateSha: CANDIDATE,
      observedCleanupRunId: ACTIVATION_RUN_ID,
      signedActivationRunId: ACTIVATION_RUN_ID,
      cleanupWorkflowPath: ".github/workflows/activate-production-promotion-recovery.yml",
      projectId: TARGET_PROJECT_ID,
      projectName: "pintpath-disposable-restore-fixture",
      environmentId: TARGET_ENVIRONMENT_ID,
      environmentName: "production",
      expectedInventorySha256: "3".repeat(64),
      workspaceId: "66666666-6666-4666-8666-666666666666",
      workspaceName: "Pint Path",
      expectedWorkspaceProjectInventorySha256: "a".repeat(64),
      emergencyCleanupArmAuthoritySha256: "b".repeat(64),
      policySha256: "4d1c22a4d5779f9383e133a1da8cfa40d10a6317343298210efc81e4f18403ef",
      teardownAuthoritySha256: "4".repeat(64),
      teardownAuthorityPublicKeySha256: "5".repeat(64),
      teardownAuthorityReviewerIdSha256: "6".repeat(64),
      intentSha256: "7".repeat(64),
      preflightInventorySha256: "8".repeat(64),
      postflightInventorySha256: "9".repeat(64),
      preflightWorkspaceProjectInventorySha256: "c".repeat(64),
      postflightWorkspaceProjectInventorySha256: "d".repeat(64),
      deleteAttempts: 1,
      retryAllowed: false,
      checks: {
        policyExact: true, githubAuthorityExact: true, targetNotProtected: true,
        signedAuthorityExact: true, credentialsSeparatedExact: true,
        metadataAuthoritiesAgree: true, completeInventoryExact: true,
        signedServiceInventoryExact: true, durableIntentExact: true,
        workspaceAuthoritiesExact: true, completeWorkspaceInventoryExact: true,
        signedWorkspaceInventoryExact: true,
        deleteAttemptedAtMostOnce: true, acknowledgementExact: true,
        postflightAttempted: true, targetAbsentExact: true, terminalEvidenceExact: true,
      },
    });
    put("railway-teardown-terminal", {
      schemaVersion: "pintpath-production-recovery-railway-teardown-terminal/v1",
      receipt: railwayTeardownReceipt,
    });
    const supabaseTeardownReceipt = receiptWithHash({
      schemaVersion: 1,
      kind: "pintpath-protected-disposable-supabase-project-teardown",
      ok: true,
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      outcome: "deleted",
      completedAt: "2026-08-14T00:14:55.000Z",
      candidateSha: CANDIDATE,
      observedCleanupRunId: ACTIVATION_RUN_ID,
      signedActivationRunId: ACTIVATION_RUN_ID,
      cleanupWorkflowPath: ".github/workflows/activate-production-promotion-recovery.yml",
      projectRef: TARGET_SUPABASE_PROJECT_REF,
      projectName: "pintpath-disposable-restore-fixture",
      organizationSlugSha256: "0".repeat(64),
      cleanupMode: "orderly",
      purgeReceiptSha256: sha256(fs.readFileSync(storagePurgeFile)),
      destinationOriginSha256: TARGET_SUPABASE_ORIGIN_SHA256,
      targetRailwayProjectId: TARGET_PROJECT_ID,
      targetRailwayEnvironmentId: TARGET_ENVIRONMENT_ID,
      destinationRestoreAuthoritySha256: HASH,
      emergencyCleanupArmAuthoritySha256: "e".repeat(64),
      policySha256: "fd3a45234a02ba3df8fadb6e2f36d1070a72be75eec792986f85abd74e5f6796",
      teardownAuthoritySha256: "1".repeat(64),
      teardownAuthorityPublicKeySha256: "2".repeat(64),
      teardownAuthorityReviewerIdSha256: "3".repeat(64),
      intentSha256: "4".repeat(64),
      preflightInventorySha256: "5".repeat(64),
      postflightInventorySha256: "6".repeat(64),
      deleteAttempts: 1,
      retryAllowed: false,
      checks: {
        policyExact: true, githubAuthorityExact: true, targetNotProtected: true,
        orderlyPurgeEvidenceExactOrNotRequired: true, signedAuthorityExact: true,
        credentialsSeparatedExact: true, preflightInventoryExact: true,
        targetMetadataExact: true, durableIntentExact: true,
        deleteAttemptedAtMostOnce: true, acknowledgementExact: true,
        postflightAttempted: true, targetAbsentExact: true, terminalEvidenceExact: true,
      },
    });
    put("supabase-teardown-terminal", {
      schemaVersion: "pintpath-protected-disposable-supabase-project-teardown-terminal/v1",
      receipt: supabaseTeardownReceipt,
    });
    const activationEvidence = PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_EVIDENCE.map((leaf) => {
      const name = leaf.slice(0, -".json".length);
      return { leaf, sha256: fileSha(name) };
    });
    const cleanupEvidence = [
      "railway-teardown-terminal.json",
      "storage-purge-receipt.json",
      "supabase-teardown-terminal.json",
    ].map((leaf) => ({ leaf, sha256: fileSha(leaf.slice(0, -".json".length)) }));
    const activationWithoutHash = {
      schemaVersion: 1,
      kind: "pintpath-production-promotion-recovery-activation",
      candidateSha: CANDIDATE,
      producerWorkflow: "activate-production-promotion-recovery.yml",
      producerRunId: ACTIVATION_RUN_ID,
      producerRunAttempt: "1",
      completedAt: "2026-08-14T00:15:00.000Z",
      targetProjectIdSha256: sha256(TARGET_PROJECT_ID),
      targetEnvironmentIdSha256: sha256(TARGET_ENVIRONMENT_ID),
      targetDatabaseIdentitySha256: TARGET,
      targetSupabaseOriginSha256: TARGET_SUPABASE_ORIGIN_SHA256,
      evidence: activationEvidence,
      evidenceAggregateSha256: sha256ProductionPromotionRecoveryValue(activationEvidence),
      cleanupEvidenceAggregateSha256: sha256ProductionPromotionRecoveryValue(cleanupEvidence),
      allOperationsExact: true,
      targetAbsent: true,
    };
    put("activation-receipt", receiptWithHash(activationWithoutHash));
    put("activation-github-authority", {
      schemaVersion: 1,
      kind: "pintpath-production-promotion-recovery-activation-github-authority",
      repository: "blackmagic30/Beer",
      candidateSha: CANDIDATE,
      workflowPath: ".github/workflows/activate-production-promotion-recovery.yml",
      workflowRunId: ACTIVATION_RUN_ID,
      workflowRunAttempt: 1,
      workflowRunStartedAt: "2026-08-14T00:10:00.000Z",
      workflowEvent: "workflow_dispatch",
      workflowConclusion: "success",
      artifactName: `pintpath-production-promotion-recovery-activation-${CANDIDATE}`,
      artifactId: "987654321",
      artifactDigest: `sha256:${"9".repeat(64)}`,
      artifactSizeBytes: 12345,
      artifactExpired: false,
    });
    const keys = [crypto.generateKeyPairSync("ed25519"), crypto.generateKeyPairSync("ed25519")];
    const publicKeys = keys.map((pair, index) => {
      const bytes = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" }));
      const filename = path.join(root, `reviewer-${index + 1}.pem`);
      fs.writeFileSync(filename, bytes, { mode: 0o600 });
      fs.chmodSync(filename, 0o600);
      return { bytes, filename, sha256: sha256(bytes) };
    });
    files.set("approval-one-public-key", publicKeys[0]!.filename);
    files.set("approval-two-public-key", publicKeys[1]!.filename);
    const reviewerPublicKeySha256s = publicKeys.map((entry) => entry.sha256).sort() as [string, string];
    const authority = {
      schemaVersion: PRODUCTION_PROMOTION_RECOVERY_AUTHORITY_SCHEMA,
      candidateSha: CANDIDATE,
      productionDeploymentReceiptSha256: fileSha("production-deployment-receipt"),
      productionDeploymentIdSha256: ACTIVE_DEPLOYMENT_ID_SHA256,
      productionScaleReceiptSha256: fileSha("production-scale-receipt"),
      closedRouteReceiptSha256: fileSha("closed-route-receipt"),
      closedRouteTerminalEvidenceSha256: fileSha("closed-route-terminal"),
      applyAuthorizationReceiptSha256: fileSha("apply-authorization-receipt"),
      applyOperationReceiptSha256: fileSha("apply-operation-receipt"),
      pitrReceiptSha256: fileSha("pitr-receipt"),
      pitrObservedAt: "2026-08-14T00:06:00.000Z",
      logicalBackupManifestSha256: backup.manifestSha256,
      logicalOffsiteResultSha256: fileSha("logical-offsite-result"),
      logicalWormResultSha256: fileSha("logical-worm-result"),
      logicalWormRetrievalReceiptSha256: fileSha("logical-worm-retrieval-receipt"),
      logicalWormRetrievedAt: "2026-08-14T00:10:30.000Z",
      privateStorageCaptureReceiptSha256: fileSha("private-storage-capture-receipt"),
      offsiteRetrievalReceiptSha256: fileSha("offsite-retrieval-receipt"),
      logicalRestoreReceiptSha256: fileSha("logical-restore-receipt"),
      privateStorageRestoreReceiptSha256: fileSha("private-storage-restore-receipt"),
      deletionReplayFirstReceiptSha256: fileSha("deletion-replay-first-receipt"),
      deletionReplaySecondReceiptSha256: fileSha("deletion-replay-second-receipt"),
      activationProducerRepository: "blackmagic30/Beer",
      activationProducerWorkflowPath:
        ".github/workflows/activate-production-promotion-recovery.yml",
      activationProducerRunId: ACTIVATION_RUN_ID,
      activationProducerRunAttempt: 1,
      activationArtifactName:
        `pintpath-production-promotion-recovery-activation-${CANDIDATE}`,
      activationArtifactId: "987654321",
      activationArtifactDigest: `sha256:${"9".repeat(64)}`,
      activationArtifactSizeBytes: 12345,
      activationGithubAuthoritySha256: fileSha("activation-github-authority"),
      activationReceiptSha256: fileSha("activation-receipt"),
      activationEvidenceAggregateSha256:
        sha256ProductionPromotionRecoveryValue(activationEvidence),
      privateStorageWormReceiptSha256: fileSha("private-storage-worm-receipt"),
      privateStorageWormRetrievalReceiptSha256:
        fileSha("private-storage-worm-retrieval-receipt"),
      recoveredApplicationReceiptSha256: fileSha("recovered-smoke-receipt"),
      storagePurgeReceiptSha256: fileSha("storage-purge-receipt"),
      railwayTeardownTerminalSha256: fileSha("railway-teardown-terminal"),
      supabaseTeardownTerminalSha256: fileSha("supabase-teardown-terminal"),
      cleanupEvidenceAggregateSha256:
        sha256ProductionPromotionRecoveryValue(cleanupEvidence),
      recoveryPointAt: "2026-08-14T00:05:00.000Z",
      recoveryStartedAt: "2026-08-14T00:10:00.000Z",
      applicationReadyAt: "2026-08-14T00:14:30.000Z",
      recoveryCompletedAt: "2026-08-14T00:14:40.000Z",
      cleanupStartedAt: "2026-08-14T00:14:40.000Z",
      cleanupCompletedAt: "2026-08-14T00:15:00.000Z",
      rpoSeconds: 60,
      rtoSeconds: 270,
      cleanupSeconds: 20,
      reviewerPublicKeySha256s,
    };
    const authorityFile = put("authority", authority);
    const authoritySha256 = sha256(fs.readFileSync(authorityFile));
    const approvalAt = ["2026-08-14T00:16:00.000Z", "2026-08-14T00:17:00.000Z"];
    keys.forEach((pair, index) => {
      const payload = {
        schemaVersion: "pintpath-production-promotion-recovery-approval-payload/v1",
        authorityManifestSha256: authoritySha256,
        candidateSha: CANDIDATE,
        reviewerIdSha256: index === 0 ? HASH : OTHER_HASH,
        reviewerPublicKeySha256: publicKeys[index]!.sha256,
        approvedAt: approvalAt[index]!,
      };
      put(`approval-${index === 0 ? "one" : "two"}`, {
        schemaVersion: PRODUCTION_PROMOTION_RECOVERY_APPROVAL_SCHEMA,
        payload,
        signatureBase64: crypto.sign(
          null,
          Buffer.from(canonicalPostgresBackupJson(payload)),
          pair.privateKey,
        ).toString("base64"),
      });
    });
    const output = path.join(root, "receipt.json");
    const argumentNames = [
      "authority", "production-deployment-receipt", "production-scale-receipt",
      "activation-receipt", "activation-github-authority",
      "closed-route-receipt", "closed-route-terminal", "apply-authorization-receipt",
      "apply-operation-receipt", "pitr-receipt", "logical-backup-manifest",
      "logical-offsite-result", "logical-worm-result", "logical-worm-retrieval-receipt",
      "private-storage-capture-receipt",
      "private-storage-recovery-manifest", "offsite-retrieval-receipt",
      "logical-restore-receipt", "private-storage-restore-receipt",
      "deletion-replay-first-receipt", "deletion-replay-second-receipt",
      "private-storage-worm-receipt", "private-storage-worm-retrieval-receipt",
      "recovered-smoke-receipt", "storage-purge-receipt",
      "railway-teardown-terminal", "supabase-teardown-terminal",
      "approval-one", "approval-one-public-key", "approval-two", "approval-two-public-key",
    ];
    const argv = argumentNames.flatMap((name) => [`--${name}`, files.get(name)!]);
    argv.push(
      "--authority-sha256", authoritySha256,
      "--expected-reviewer-one-public-key-sha256", publicKeys[0]!.sha256,
      "--expected-reviewer-two-public-key-sha256", publicKeys[1]!.sha256,
      "--candidate-sha", CANDIDATE,
      "--output", output,
    );
    let stdout = "";
    const receipt = await attestProductionPromotionRecovery({
      argv,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_PRODUCTION_PROMOTION_RECOVERY_CONFIRMATION:
          "ATTEST_PRODUCTION_PROMOTION_RECOVERY",
      },
      cwd: process.cwd(),
      now: () => new Date("2026-08-14T00:18:00.000Z"),
      writeOutput: (source) => { stdout += source; },
    });
    expect(receipt).toMatchObject({
      outcome: "verified",
      candidateSha: CANDIDATE,
      policySha256: PRODUCTION_PROMOTION_RECOVERY_POLICY_SHA256,
      productionDeploymentIdSha256: ACTIVE_DEPLOYMENT_ID_SHA256,
      productionScaleReceiptSha256: authority.productionScaleReceiptSha256,
      quarantineReceiptSha256: null,
      rpoSeconds: 60,
      rtoSeconds: 270,
    });
    expect(Object.values(receipt.checks)).not.toContain(false);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, candidateSha: CANDIDATE });
    expect(sha256(fs.readFileSync(output))).toBe(
      sha256ProductionPromotionRecoveryBytes(canonicalPostgresBackupJson(receipt)),
    );
    expect(fs.statSync(output).mode & 0o7777).toBe(0o600);

    const recoveredApplication = JSON.parse(
      fs.readFileSync(files.get("recovered-smoke-receipt")!, "utf8"),
    ) as Record<string, unknown>;
    for (const mutate of [
      (value: Record<string, unknown>) => {
        delete value.runtimeDependencyBoundaryExact;
      },
      (value: Record<string, unknown>) => {
        value.runtimeDependencyBoundaryExact = false;
      },
      (value: Record<string, unknown>) => {
        delete value.runtimeDependencyArtifactSha256;
      },
      (value: Record<string, unknown>) => {
        value.unexpectedRuntimeDependencyProof = true;
      },
    ]) {
      const { receiptSha256: _discardedReceiptSha256, ...withoutHash } =
        recoveredApplication;
      const changed = { ...withoutHash };
      mutate(changed);
      expect(productionRecoveryRecoveredApplicationSchema.safeParse(
        receiptWithHash(changed),
      ).success).toBe(false);
    }

    const lateAuthority = {
      ...authority,
      recoveryStartedAt: "2026-08-14T00:10:29.000Z",
      rtoSeconds: 241,
    };
    const lateAuthorityFile = put("late-authority", lateAuthority);
    const lateAuthoritySha256 = sha256(fs.readFileSync(lateAuthorityFile));
    const lateApprovalFiles = keys.map((pair, index) => {
      const payload = {
        schemaVersion: "pintpath-production-promotion-recovery-approval-payload/v1",
        authorityManifestSha256: lateAuthoritySha256,
        candidateSha: CANDIDATE,
        reviewerIdSha256: index === 0 ? HASH : OTHER_HASH,
        reviewerPublicKeySha256: publicKeys[index]!.sha256,
        approvedAt: approvalAt[index]!,
      };
      return put(`late-approval-${index + 1}`, {
        schemaVersion: PRODUCTION_PROMOTION_RECOVERY_APPROVAL_SCHEMA,
        payload,
        signatureBase64: crypto.sign(
          null,
          Buffer.from(canonicalPostgresBackupJson(payload)),
          pair.privateKey,
        ).toString("base64"),
      });
    });
    const lateStartArgv = [...argv];
    lateStartArgv[lateStartArgv.indexOf("--authority") + 1] = lateAuthorityFile;
    lateStartArgv[lateStartArgv.indexOf("--authority-sha256") + 1] = lateAuthoritySha256;
    lateStartArgv[lateStartArgv.indexOf("--approval-one") + 1] = lateApprovalFiles[0]!;
    lateStartArgv[lateStartArgv.indexOf("--approval-two") + 1] = lateApprovalFiles[1]!;
    lateStartArgv[lateStartArgv.indexOf("--output") + 1] = path.join(root, "late-start.json");
    await expect(attestProductionPromotionRecovery({
      argv: lateStartArgv,
      env: {
        GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer", GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_PRODUCTION_PROMOTION_RECOVERY_CONFIRMATION:
          "ATTEST_PRODUCTION_PROMOTION_RECOVERY",
      },
      cwd: process.cwd(), now: () => new Date("2026-08-14T00:18:00.000Z"),
    })).rejects.toMatchObject({ code: "activation_authority_binding_invalid" });

    const argvWithOutput = (leaf: string) => {
      const next = [...argv];
      next[next.indexOf("--output") + 1] = path.join(root, leaf);
      return next;
    };
    const rewriteFirstApproval = (approvedAt: string) => {
      const payload = {
        schemaVersion: "pintpath-production-promotion-recovery-approval-payload/v1",
        authorityManifestSha256: authoritySha256,
        candidateSha: CANDIDATE,
        reviewerIdSha256: HASH,
        reviewerPublicKeySha256: publicKeys[0]!.sha256,
        approvedAt,
      };
      put("approval-one", {
        schemaVersion: PRODUCTION_PROMOTION_RECOVERY_APPROVAL_SCHEMA,
        payload,
        signatureBase64: crypto.sign(
          null,
          Buffer.from(canonicalPostgresBackupJson(payload)),
          keys[0]!.privateKey,
        ).toString("base64"),
      });
    };
    rewriteFirstApproval("2026-08-14T00:14:59.000Z");
    await expect(attestProductionPromotionRecovery({
      argv: argvWithOutput("predated.json"),
      env: {
        GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer", GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_PRODUCTION_PROMOTION_RECOVERY_CONFIRMATION:
          "ATTEST_PRODUCTION_PROMOTION_RECOVERY",
      },
      cwd: process.cwd(), now: () => new Date("2026-08-14T00:18:00.000Z"),
    })).rejects.toMatchObject({ code: "chronology_invalid" });

    rewriteFirstApproval("2026-08-14T00:19:00.000Z");
    await expect(attestProductionPromotionRecovery({
      argv: argvWithOutput("future.json"),
      env: {
        GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer", GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_PRODUCTION_PROMOTION_RECOVERY_CONFIRMATION:
          "ATTEST_PRODUCTION_PROMOTION_RECOVERY",
      },
      cwd: process.cwd(), now: () => new Date("2026-08-14T00:18:00.000Z"),
    })).rejects.toMatchObject({ code: "chronology_invalid" });

    const purge = JSON.parse(
      fs.readFileSync(files.get("storage-purge-receipt")!, "utf8"),
    ) as Record<string, unknown>;
    put("storage-purge-receipt", { ...purge, candidateSha: "d".repeat(40) });
    await expect(attestProductionPromotionRecovery({
      argv: argvWithOutput("substituted.json"),
      env: {
        GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer", GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_PRODUCTION_PROMOTION_RECOVERY_CONFIRMATION:
          "ATTEST_PRODUCTION_PROMOTION_RECOVERY",
      },
      cwd: process.cwd(), now: () => new Date("2026-08-14T00:20:00.000Z"),
    })).rejects.toMatchObject({ code: "storage-purge-receipt_hash_mismatch" });
  });
});
