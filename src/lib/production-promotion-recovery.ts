import crypto from "node:crypto";

import { z } from "zod";

import { canonicalPostgresBackupJson } from "./postgres-logical-backup.js";

export const PRODUCTION_PROMOTION_RECOVERY_AUTHORITY_SCHEMA =
  "pintpath-production-promotion-recovery-authority/v2" as const;
export const PRODUCTION_PROMOTION_RECOVERY_APPROVAL_SCHEMA =
  "pintpath-production-promotion-recovery-signed-approval/v1" as const;
export const PRODUCTION_PROMOTION_RECOVERY_RECEIPT_SCHEMA =
  "pintpath-production-promotion-recovery-receipt/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const sha = z.string().regex(SHA256);
const candidate = z.string().regex(CANDIDATE);
const timestamp = z
  .string()
  .datetime({ offset: false, precision: 3 })
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  );
const positiveDecimal = z.string().regex(/^[1-9]\d*$/);
const uuid = z.string().uuid();
const projectName = z
  .string()
  .regex(/^pintpath-disposable-restore-[a-z0-9][a-z0-9-]{0,79}$/);

export const productionRecoveryLogicalWormResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.literal(true),
    backupCreatedAt: timestamp,
    completedAt: timestamp,
    archiveSha256: sha,
    manifestSha256: sha,
    stateReceiptSha256: sha,
    overallStateSha256: sha,
    backupIdSha256: sha,
    recoveryAccountIdSha256: sha,
    bucketNameSha256: sha,
    writerPrincipalArnSha256: sha,
    readerPrincipalArnSha256: sha,
    immutableObjectSetSha256: sha,
    writerDenialSetSha256: sha,
    receiptSha256: sha,
    receiptObjectKeySha256: sha,
    receiptVersionIdSha256: sha,
    receiptDenialSetSha256: sha,
    minimumRetainUntil: timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.writerPrincipalArnSha256 === value.readerPrincipalArnSha256 ||
      Date.parse(value.backupCreatedAt) > Date.parse(value.completedAt) ||
      Date.parse(value.completedAt) >= Date.parse(value.minimumRetainUntil)
    ) {
      context.addIssue({
        code: "custom",
        message: "logical WORM chronology/authority mismatch",
      });
    }
  });

export const productionRecoveryLogicalWormRetrievalSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("pintpath-postgres-logical-worm-retrieval"),
    ok: z.literal(true),
    retrievedAt: timestamp,
    backupCreatedAt: timestamp,
    archiveSha256: sha,
    manifestSha256: sha,
    stateReceiptSha256: sha,
    sourceDatabaseIdentitySha256: sha,
    overallStateSha256: sha,
    backupIdSha256: sha,
    wormResultSha256: sha,
    wormReceiptSha256: sha,
    immutableObjectSetSha256: sha,
    archiveBytes: z.number().int().positive(),
    manifestBytes: z.number().int().positive(),
    stateReceiptBytes: z.number().int().positive(),
    localArtifactSetSha256: sha,
    recoveryAccountIdSha256: sha,
    bucketNameSha256: sha,
    readerPrincipalArnSha256: sha,
    minimumRetainUntil: timestamp,
  })
  .strict();

export const productionRecoveryPrivateWormResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.literal(true),
    kind: z.literal("pintpath-postgres-private-storage-worm-receipt"),
    candidateSha: candidate,
    completedAt: timestamp,
    recoverySetSha256: sha,
    recoveryManifestSha256: sha,
    logicalBackupManifestSha256: sha,
    bundleManifestSha256: sha,
    immutableObjectSetSha256: sha,
    recoveryAccountIdSha256: sha,
    bucketNameSha256: sha,
    writerPrincipalArnSha256: sha,
    readerPrincipalArnSha256: sha,
    writerDenialSetSha256: sha,
    receiptSha256: sha,
    receiptObjectKeySha256: sha,
    receiptVersionIdSha256: sha,
    receiptDenialSetSha256: sha,
    minimumRetainUntil: timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.writerPrincipalArnSha256 === value.readerPrincipalArnSha256 ||
      Date.parse(value.completedAt) >= Date.parse(value.minimumRetainUntil)
    ) {
      context.addIssue({
        code: "custom",
        message: "private WORM chronology/authority mismatch",
      });
    }
  });

export const productionRecoveryPrivateWormRetrievalSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.literal(true),
    kind: z.literal("pintpath-postgres-private-storage-worm-retrieval"),
    candidateSha: candidate,
    recoveredAt: timestamp,
    recoverySetSha256: sha,
    recoveryManifestSha256: sha,
    logicalBackupManifestSha256: sha,
    bundleManifestSha256: sha,
    wormResultSha256: sha,
    wormReceiptSha256: sha,
    immutableObjectSetSha256: sha,
    entrySetSha256: sha,
    recoveredEntryCount: z.number().int().min(4).max(10_004),
    recoveredBytes: positiveDecimal,
    recoveryAccountIdSha256: sha,
    bucketNameSha256: sha,
    readerPrincipalArnSha256: sha,
    minimumRetainUntil: timestamp,
  })
  .strict();

export const productionRecoveryLogicalOffsiteResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.literal(true),
    backupCreatedAt: timestamp,
    completedAt: timestamp,
    archiveSha256: sha,
    manifestSha256: sha,
    stateReceiptSha256: sha,
    overallStateSha256: sha,
    sourceDatabaseIdentitySha256: sha,
    remoteObjectSetSha256: sha,
    attestationSha256: sha,
    latestPointerSha256: sha,
    backupIdSha256: sha,
    successStateSha256: sha,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.backupCreatedAt) > Date.parse(value.completedAt)) {
      context.addIssue({
        code: "custom",
        message: "offsite result chronology mismatch",
      });
    }
  });

export const productionRecoveryLogicalOffsiteRetrievalSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("pintpath-postgres-logical-offsite-retrieval"),
    ok: z.literal(true),
    retrievedAt: timestamp,
    successStateSha256: sha,
    backupCreatedAt: timestamp,
    backupIdSha256: sha,
    latestPointerSha256: sha,
    attestationSha256: sha,
    remoteObjectSetSha256: sha,
    archiveSha256: sha,
    manifestSha256: sha,
    stateReceiptSha256: sha,
    sourceDatabaseIdentitySha256: sha,
    overallStateSha256: sha,
    archiveBytes: z.number().int().positive(),
    manifestBytes: z.number().int().positive(),
    stateReceiptBytes: z.number().int().positive(),
    localArtifactSetSha256: sha,
  })
  .strict();

export const productionRecoveryPrivateCaptureSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("pintpath-postgres-private-storage-recovery-capture"),
    ok: z.literal(true),
    capturedAt: timestamp,
    logicalBackupManifestSha256: sha,
    storageObjectCount: z.number().int().positive(),
    databaseReferenceCount: z.number().int().positive(),
    deletionTombstoneCount: z.number().int().positive(),
    recoverySetSha256: sha,
    recoveryManifestSha256: sha,
    databaseConnectionUrlSha256: sha,
    databaseTransportProfile: z.literal("railway-stock-localhost-ca-v1"),
    databaseTransportRootCaDerSha256: sha,
    databaseEffectiveRole: z.literal("pintpath_migrator"),
  })
  .strict();

export const productionRecoveryPrivateRestoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("pintpath-postgres-private-storage-recovery-restore"),
    ok: z.literal(true),
    restoredAt: timestamp,
    targetDatabaseIdentitySha256: sha,
    recoverySetSha256: sha,
    recoveryManifestSha256: sha,
    restoredObjectCount: z.number().int().positive(),
    restoredBytes: positiveDecimal,
    destinationObjectSetSha256: sha,
    deletionAuthoritySetSha256: sha,
    databaseTransportProfile: z.literal("railway-stock-localhost-ca-v1"),
    databaseTransportRootCaDerSha256: sha,
    databaseEffectiveRole: z.literal("pintpath_migrator"),
    candidateSha: candidate,
    destinationConnectionUrlSha256: sha,
    destinationOriginSha256: sha,
    destinationBucketNameSha256: sha,
    destinationAuthoritySha256: sha,
    destinationAuthorityPublicKeySha256: sha,
    destinationAuthorityReviewerIdSha256: sha,
    destinationRailwayProjectIdSha256: sha,
    destinationRailwayEnvironmentIdSha256: sha,
  })
  .strict();

export const productionRecoveryLogicalRestoreReceiptSchema = z
  .object({
    kind: z.literal("pintpath-postgres-logical-restore"),
    version: z.literal(1),
    status: z.literal("verified"),
    restoredAt: timestamp,
    backupManifestSha256: sha,
    backupArchiveSha256: sha,
    targetIdentitySha256: sha,
    targetUrlSha256: sha,
    authoritativeTableCount: z.number().int().positive(),
    authoritativeColumnCount: z.number().int().positive(),
    foreignKeyCount: z.number().int().nonnegative(),
    authoritativeRowCount: z.string().regex(/^(?:0|[1-9]\d*)$/),
    nonEmptyAuthoritativeTableCount: z.number().int().nonnegative(),
    authoritativeCountInventorySha256: sha,
    controlCountInventorySha256: sha,
    schemaMetadataSha256: sha,
    rowSecurityTableCount: z.number().int().nonnegative(),
    aclContractSha256: sha,
    apiRolesIsolated: z.literal(true),
    runtimeApplicationAccessRestored: z.literal(true),
    migratorReconciliationAccessVerified: z.literal(true),
    runtimeOperationsIsolated: z.literal(true),
    promotionReconciliationReady: z.literal(true),
    sourceStateBindingStatus: z.literal("exact-match"),
    expectedSourceStateReceiptSha256: sha,
    sourceSnapshotBindingSha256: sha,
    expectedSourceTableSetSha256: sha,
    expectedSourceDataSha256: sha,
    expectedSourceStateTotalsSha256: sha,
    expectedSourceKeyRangesSha256: sha,
    expectedArchivedControlTableSetSha256: sha,
    expectedArchivedControlDataSha256: sha,
    expectedArchivedControlKeyRangesSha256: sha,
    expectedSourceOverallStateSha256: sha,
    restoredOverallStateSha256: sha,
    exactDataReconciliation: z.literal("canonical-contract-exact"),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.nonEmptyAuthoritativeTableCount > value.authoritativeTableCount ||
      value.restoredOverallStateSha256 !==
        value.expectedSourceOverallStateSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "logical restore relation mismatch",
      });
    }
  });

export const productionRecoveryPitrReceiptSchema = z
  .object({
    schemaVersion: z.literal(
      "pintpath-production-post-promotion-pitr-observation/v1",
    ),
    outcome: z.literal("verified"),
    candidateSha: candidate,
    productionDeploymentIdSha256: sha,
    recoveryPointAt: timestamp,
    observedAt: timestamp,
    pitrEnabledAt: timestamp,
    projectIdSha256: sha,
    environmentIdSha256: sha,
    rootServiceIdSha256: sha,
    pitrWorkflowIdSha256: sha,
    providerHealthSha256: sha,
    pitrEnabled: z.literal(true),
    clusterHealthy: z.literal(true),
    receiptSha256: sha,
  })
  .strict()
  .superRefine((value, context) => {
    const { receiptSha256, ...withoutHash } = value;
    if (
      Date.parse(value.pitrEnabledAt) > Date.parse(value.recoveryPointAt) ||
      Date.parse(value.recoveryPointAt) > Date.parse(value.observedAt) ||
      sha256ProductionPromotionRecoveryValue(withoutHash) !== receiptSha256
    ) {
      context.addIssue({ code: "custom", message: "PITR receipt mismatch" });
    }
  });

export const productionRecoveryRecoveredApplicationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("pintpath-recovered-postgres-application-smoke"),
    status: z.literal("verified"),
    ok: z.literal(true),
    candidateSha: candidate,
    targetIdentitySha256: sha,
    applicationReadyAt: timestamp,
    completedAt: timestamp,
    checkedAt: timestamp,
    firstReplayReceiptSha256: sha,
    secondReplayReceiptSha256: sha,
    semanticProjectionSha256: sha,
    tombstoneCount: z.number().int().positive(),
    compiledArtifactSha256: sha,
    compiledEntrypointSha256: sha,
    compiledArtifactExact: z.literal(true),
    runtimeDependencyBoundaryExact: z.literal(true),
    runtimeDependencyArtifactSha256: sha,
    runtimeDependencyPackageLockSha256: sha,
    runtimeDependencyPackageCount: z.number().int().positive(),
    runtimeDependencyFileCount: z.number().int().positive(),
    runtimeDependencyBytes: z.number().int().positive(),
    candidateArtifactBindingExact: z.literal(true),
    compiledApplicationStarted: z.literal(true),
    startupProbeExact: z.literal(true),
    startupRouteReady: z.literal(true),
    readyProbeExact: z.literal(true),
    readyRouteReady: z.literal(true),
    authenticatedBoundaryExact: z.literal(true),
    authenticatedRuntimeExact: z.literal(true),
    authSubjectSha256: sha,
    authEmailSha256: sha,
    supabaseOriginSha256: sha,
    supabasePublishableKeySha256: sha,
    disposableSupabaseCredentialExact: z.literal(true),
    restoredAuthAccountPreexistingExact: z.literal(true),
    noAdminOrVenueElevationExact: z.literal(true),
    adminBoundaryDeniedExact: z.literal(true),
    deletionMutationDeniedExact: z.literal(true),
    noPrivateDataLeakageExact: z.literal(true),
    crossProjectTokenRejectedLocally: z.literal(true),
    crossProjectTokenRejectedLocallyExact: z.literal(true),
    crossProjectTokenParserRejectedLocallyExact: z.literal(true),
    appSessionRevokedExact: z.literal(true),
    providerSessionLogoutExact: z.literal(true),
    runtimeRoleExact: z.literal(true),
    maintenanceRoleRestricted: z.literal(true),
    applicationStateReady: z.literal(true),
    deletionPrivacyReconciled: z.literal(true),
    automaticMaintenanceWorkersExternalWritesDisabledExact: z.literal(true),
    automaticStartupMaintenanceWorkersExternalWritesDisabledExact:
      z.literal(true),
    runtimeMaintenanceUrlsDistinctExact: z.literal(true),
    disposableRailwayIdentityExact: z.literal(true),
    disposableSupabaseIdentityExact: z.literal(true),
    disposableRedisIdentityExact: z.literal(true),
    productionPermanentStagingReuseRejectedExact: z.literal(true),
    childOutputBoundedRedactedExact: z.literal(true),
    childTerminatedExact: z.literal(true),
    applicationChildTerminated: z.literal(true),
    databaseAuthoritiesClosedExact: z.literal(true),
    transportClosedExact: z.literal(true),
    runtimeDatabaseUrlSha256: sha,
    maintenanceDatabaseUrlSha256: sha,
    redisUrlSha256: sha,
    transportProfile: z.literal("railway-stock-localhost-ca-v1"),
    transportRootCaDerSha256: sha,
    receiptSha256: sha,
  })
  .strict()
  .superRefine((value, context) => {
    const { receiptSha256, ...withoutHash } = value;
    if (
      value.checkedAt !== value.completedAt ||
      Date.parse(value.applicationReadyAt) > Date.parse(value.completedAt) ||
      value.runtimeDatabaseUrlSha256 === value.maintenanceDatabaseUrlSha256 ||
      sha256ProductionPromotionRecoveryValue(withoutHash) !== receiptSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "recovered application mismatch",
      });
    }
  });

export const productionRecoveryStoragePurgeReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("pintpath-postgres-private-storage-recovery-target-purge"),
    ok: z.literal(true),
    candidateSha: candidate,
    completedAt: timestamp,
    destinationProjectRefSha256: sha,
    targetRailwayProjectIdSha256: sha,
    targetRailwayEnvironmentIdSha256: sha,
    targetDatabaseIdentitySha256: sha,
    targetConnectionUrlSha256: sha,
    destinationOriginSha256: sha,
    bucketNameSha256: sha,
    destinationRestoreAuthoritySha256: sha,
    purgeAuthoritySha256: sha,
    purgeAuthorityPublicKeySha256: sha,
    purgeAuthorityReviewerIdSha256: sha,
    recoverySetSha256: sha,
    recoveryManifestSha256: sha,
    restoreReceiptSha256: sha,
    restoredObjectSetSha256: sha,
    removedObjectCount: z.number().int().positive(),
    bucketPrivateExact: z.literal(true),
    restoredObjectSetExact: z.literal(true),
    concurrentObjectSetAbsent: z.literal(true),
    storageObjectsAbsentExact: z.literal(true),
    receiptSha256: sha,
  })
  .strict()
  .superRefine((value, context) => {
    const { receiptSha256, ...withoutHash } = value;
    if (sha256ProductionPromotionRecoveryValue(withoutHash) !== receiptSha256) {
      context.addIssue({
        code: "custom",
        message: "purge receipt hash mismatch",
      });
    }
  });

const railwayTeardownChecksSchema = z
  .object({
    policyExact: z.literal(true),
    githubAuthorityExact: z.literal(true),
    targetNotProtected: z.literal(true),
    signedAuthorityExact: z.literal(true),
    credentialsSeparatedExact: z.literal(true),
    metadataAuthoritiesAgree: z.literal(true),
    completeInventoryExact: z.literal(true),
    signedServiceInventoryExact: z.literal(true),
    workspaceAuthoritiesExact: z.literal(true),
    completeWorkspaceInventoryExact: z.literal(true),
    signedWorkspaceInventoryExact: z.literal(true),
    durableIntentExact: z.literal(true),
    deleteAttemptedAtMostOnce: z.literal(true),
    acknowledgementExact: z.boolean(),
    postflightAttempted: z.literal(true),
    targetAbsentExact: z.literal(true),
    terminalEvidenceExact: z.literal(true),
  })
  .strict();

const railwayTeardownReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("pintpath-production-recovery-railway-teardown"),
    ok: z.literal(true),
    outcome: z.literal("deleted"),
    completedAt: timestamp,
    candidateSha: candidate,
    observedCleanupRunId: z.string().regex(RUN_ID),
    signedActivationRunId: z.string().regex(RUN_ID),
    cleanupWorkflowPath: z.literal(
      ".github/workflows/activate-production-promotion-recovery.yml",
    ),
    projectId: uuid,
    projectName,
    environmentId: uuid,
    environmentName: z.string().min(1).max(128),
    expectedInventorySha256: sha,
    workspaceId: uuid,
    workspaceName: z.string().min(1).max(100),
    expectedWorkspaceProjectInventorySha256: sha,
    emergencyCleanupArmAuthoritySha256: sha,
    policySha256: z.literal(
      "4d1c22a4d5779f9383e133a1da8cfa40d10a6317343298210efc81e4f18403ef",
    ),
    teardownAuthoritySha256: sha,
    teardownAuthorityPublicKeySha256: sha,
    teardownAuthorityReviewerIdSha256: sha,
    intentSha256: sha,
    preflightInventorySha256: sha,
    postflightInventorySha256: sha,
    preflightWorkspaceProjectInventorySha256: sha,
    postflightWorkspaceProjectInventorySha256: sha,
    deleteAttempts: z.literal(1),
    retryAllowed: z.literal(false),
    checks: railwayTeardownChecksSchema,
    receiptSha256: sha,
  })
  .strict()
  .superRefine((value, context) => {
    const { receiptSha256, ...withoutHash } = value;
    if (
      value.observedCleanupRunId !== value.signedActivationRunId ||
      value.checks.acknowledgementExact !== true ||
      sha256ProductionPromotionRecoveryValue(withoutHash) !== receiptSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Railway terminal mismatch",
      });
    }
  });

export const productionRecoveryRailwayTeardownTerminalSchema = z
  .object({
    schemaVersion: z.literal(
      "pintpath-production-recovery-railway-teardown-terminal/v1",
    ),
    receipt: railwayTeardownReceiptSchema,
  })
  .strict();

const supabaseTeardownChecksSchema = z
  .object({
    policyExact: z.literal(true),
    githubAuthorityExact: z.literal(true),
    targetNotProtected: z.literal(true),
    orderlyPurgeEvidenceExactOrNotRequired: z.literal(true),
    signedAuthorityExact: z.literal(true),
    credentialsSeparatedExact: z.literal(true),
    preflightInventoryExact: z.literal(true),
    targetMetadataExact: z.literal(true),
    durableIntentExact: z.literal(true),
    deleteAttemptedAtMostOnce: z.literal(true),
    acknowledgementExact: z.boolean(),
    postflightAttempted: z.literal(true),
    targetAbsentExact: z.literal(true),
    terminalEvidenceExact: z.literal(true),
  })
  .strict();

const supabaseTeardownReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("pintpath-protected-disposable-supabase-project-teardown"),
    ok: z.literal(true),
    executorState: z.literal("GITHUB_ENVIRONMENT_PROTECTED"),
    outcome: z.enum(["deleted", "deleted_reconciled", "already_absent"]),
    completedAt: timestamp,
    candidateSha: candidate,
    observedCleanupRunId: z.string().regex(RUN_ID),
    signedActivationRunId: z.string().regex(RUN_ID),
    cleanupWorkflowPath: z.literal(
      ".github/workflows/activate-production-promotion-recovery.yml",
    ),
    projectRef: z.string().regex(/^[a-z0-9]{20}$/),
    projectName,
    destinationOriginSha256: sha,
    organizationSlugSha256: sha,
    targetRailwayProjectId: uuid,
    targetRailwayEnvironmentId: uuid,
    cleanupMode: z.literal("orderly"),
    destinationRestoreAuthoritySha256: sha,
    emergencyCleanupArmAuthoritySha256: sha,
    purgeReceiptSha256: sha,
    policySha256: z.literal(
      "fd3a45234a02ba3df8fadb6e2f36d1070a72be75eec792986f85abd74e5f6796",
    ),
    teardownAuthoritySha256: sha,
    teardownAuthorityPublicKeySha256: sha,
    teardownAuthorityReviewerIdSha256: sha,
    intentSha256: sha,
    preflightInventorySha256: sha,
    postflightInventorySha256: sha,
    deleteAttempts: z.union([z.literal(0), z.literal(1)]),
    retryAllowed: z.literal(false),
    checks: supabaseTeardownChecksSchema,
    receiptSha256: sha,
  })
  .strict()
  .superRefine((value, context) => {
    const { receiptSha256, ...withoutHash } = value;
    if (
      value.observedCleanupRunId !== value.signedActivationRunId ||
      value.deleteAttempts !== (value.outcome === "already_absent" ? 0 : 1) ||
      value.checks.acknowledgementExact !== (value.outcome === "deleted") ||
      sha256ProductionPromotionRecoveryValue(withoutHash) !== receiptSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Supabase terminal mismatch",
      });
    }
  });

export const productionRecoverySupabaseTeardownTerminalSchema = z
  .object({
    schemaVersion: z.literal(
      "pintpath-protected-disposable-supabase-project-teardown-terminal/v1",
    ),
    receipt: supabaseTeardownReceiptSchema,
  })
  .strict();

export const productionPromotionRecoveryAuthoritySchema = z
  .object({
    schemaVersion: z.literal(PRODUCTION_PROMOTION_RECOVERY_AUTHORITY_SCHEMA),
    candidateSha: candidate,
    productionDeploymentReceiptSha256: sha,
    productionDeploymentIdSha256: sha,
    productionScaleReceiptSha256: sha,
    closedRouteReceiptSha256: sha,
    closedRouteTerminalEvidenceSha256: sha,
    applyAuthorizationReceiptSha256: sha,
    applyOperationReceiptSha256: sha,
    pitrReceiptSha256: sha,
    pitrObservedAt: timestamp,
    logicalBackupManifestSha256: sha,
    logicalOffsiteResultSha256: sha,
    logicalWormResultSha256: sha,
    logicalWormRetrievalReceiptSha256: sha,
    logicalWormRetrievedAt: timestamp,
    privateStorageCaptureReceiptSha256: sha,
    offsiteRetrievalReceiptSha256: sha,
    logicalRestoreReceiptSha256: sha,
    privateStorageRestoreReceiptSha256: sha,
    deletionReplayFirstReceiptSha256: sha,
    deletionReplaySecondReceiptSha256: sha,
    activationProducerRepository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    activationProducerWorkflowPath: z.literal(
      ".github/workflows/activate-production-promotion-recovery.yml",
    ),
    activationProducerRunId: z.string().regex(RUN_ID),
    activationProducerRunAttempt: z.literal(1),
    activationArtifactName: z.string().min(1).max(255),
    activationArtifactId: z.string().regex(RUN_ID),
    activationArtifactDigest: z.string().regex(ARTIFACT_DIGEST),
    activationArtifactSizeBytes: z.number().int().min(1),
    activationGithubAuthoritySha256: sha,
    activationReceiptSha256: sha,
    activationEvidenceAggregateSha256: sha,
    privateStorageWormReceiptSha256: sha,
    privateStorageWormRetrievalReceiptSha256: sha,
    recoveredApplicationReceiptSha256: sha,
    storagePurgeReceiptSha256: sha,
    railwayTeardownTerminalSha256: sha,
    supabaseTeardownTerminalSha256: sha,
    cleanupEvidenceAggregateSha256: sha,
    recoveryPointAt: timestamp,
    recoveryStartedAt: timestamp,
    applicationReadyAt: timestamp,
    recoveryCompletedAt: timestamp,
    cleanupStartedAt: timestamp,
    cleanupCompletedAt: timestamp,
    rpoSeconds: z.number().int().min(0).max(3_600),
    rtoSeconds: z.number().int().min(1).max(14_400),
    cleanupSeconds: z.number().int().min(0).max(3_600),
    reviewerPublicKeySha256s: z
      .tuple([sha, sha])
      .refine(
        ([first, second]) => first < second,
        "reviewer public keys must be distinct and bytewise sorted",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    const recoveryPoint = Date.parse(value.recoveryPointAt);
    const started = Date.parse(value.recoveryStartedAt);
    const completed = Date.parse(value.recoveryCompletedAt);
    const applicationReady = Date.parse(value.applicationReadyAt);
    const logicalWormRetrieved = Date.parse(value.logicalWormRetrievedAt);
    const cleanupStarted = Date.parse(value.cleanupStartedAt);
    const cleanupCompleted = Date.parse(value.cleanupCompletedAt);
    if (
      recoveryPoint > started ||
      started > logicalWormRetrieved ||
      logicalWormRetrieved >= applicationReady ||
      started >= applicationReady ||
      applicationReady > completed ||
      completed > cleanupStarted ||
      cleanupStarted > cleanupCompleted ||
      Math.floor((applicationReady - started) / 1_000) !== value.rtoSeconds ||
      Math.floor((cleanupCompleted - cleanupStarted) / 1_000) !==
        value.cleanupSeconds
    )
      context.addIssue({
        code: "custom",
        message: "RPO/RTO chronology mismatch",
      });
  });

export type ProductionPromotionRecoveryAuthority = z.infer<
  typeof productionPromotionRecoveryAuthoritySchema
>;

export const productionPromotionRecoveryApprovalSchema = z
  .object({
    schemaVersion: z.literal(PRODUCTION_PROMOTION_RECOVERY_APPROVAL_SCHEMA),
    payload: z
      .object({
        schemaVersion: z.literal(
          "pintpath-production-promotion-recovery-approval-payload/v1",
        ),
        authorityManifestSha256: sha,
        candidateSha: candidate,
        reviewerIdSha256: sha,
        reviewerPublicKeySha256: sha,
        approvedAt: timestamp,
      })
      .strict(),
    signatureBase64: z.string().min(1).max(256).regex(BASE64),
  })
  .strict();

export type ProductionPromotionRecoveryApproval = z.infer<
  typeof productionPromotionRecoveryApprovalSchema
>;

export const productionPromotionRecoveryChecksSchema = z
  .object({
    authorityExact: z.literal(true),
    candidateExact: z.literal(true),
    productionDeploymentExact: z.literal(true),
    productionScaleExact: z.literal(true),
    closedRouteExact: z.literal(true),
    promotionAuthorizationExact: z.literal(true),
    promotionApplyExact: z.literal(true),
    quarantineAbsent: z.literal(true),
    pitrExact: z.literal(true),
    logicalBackupExact: z.literal(true),
    operationalOffsiteExact: z.literal(true),
    wormIndependentReaderExact: z.literal(true),
    privateStorageCaptureExact: z.literal(true),
    offsiteRetrievalExact: z.literal(true),
    disposableLogicalRestoreExact: z.literal(true),
    disposablePrivateStorageRestoreExact: z.literal(true),
    deletionReplayAppliedExact: z.literal(true),
    deletionReplayIdempotentExact: z.literal(true),
    transportAndRoleExact: z.literal(true),
    recoveryStateBindingsExact: z.literal(true),
    activationProducerExact: z.literal(true),
    recoveredApplicationExact: z.literal(true),
    teardownAbsentExact: z.literal(true),
    rpoRtoExact: z.literal(true),
    twoPersonApprovalExact: z.literal(true),
    chronologyExact: z.literal(true),
  })
  .strict();

const receiptWithoutHashSchema = z
  .object({
    schemaVersion: z.literal(PRODUCTION_PROMOTION_RECOVERY_RECEIPT_SCHEMA),
    outcome: z.literal("verified"),
    candidateSha: candidate,
    githubEnvironment: z.literal("production-promotion-recovery"),
    policySha256: sha,
    authorityManifestSha256: sha,
    activationReceiptSha256: sha,
    activationGithubAuthoritySha256: sha,
    activationProducerWorkflow: z.literal(
      "activate-production-promotion-recovery.yml",
    ),
    activationProducerRunId: z.string().regex(RUN_ID),
    activationProducerRunAttempt: z.literal(1),
    activationRepository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    activationArtifactName: z.string().min(1).max(255),
    activationArtifactId: z.string().regex(RUN_ID),
    activationArtifactDigest: z.string().regex(ARTIFACT_DIGEST),
    activationArtifactSizeBytes: z.number().int().min(1),
    activationTargetProjectIdSha256: sha,
    activationTargetEnvironmentIdSha256: sha,
    activationTargetSupabaseOriginSha256: sha,
    privateStorageWormReceiptSha256: sha,
    privateStorageWormRetrievalReceiptSha256: sha,
    recoveredApplicationReceiptSha256: sha,
    storagePurgeReceiptSha256: sha,
    railwayTeardownTerminalSha256: sha,
    supabaseTeardownTerminalSha256: sha,
    activationEvidenceAggregateSha256: sha,
    cleanupEvidenceAggregateSha256: sha,
    productionDeploymentReceiptSha256: sha,
    productionDeploymentIdSha256: sha,
    productionScaleReceiptSha256: sha,
    closedRouteReceiptSha256: sha,
    closedRouteTerminalEvidenceSha256: sha,
    applyAuthorizationReceiptSha256: sha,
    applyOperationReceiptSha256: sha,
    promotionOperationId: z.string().uuid(),
    promotionCommittedAt: timestamp,
    quarantineReceiptSha256: z.null(),
    pitrReceiptSha256: sha,
    pitrObservedAt: timestamp,
    logicalBackupManifestSha256: sha,
    logicalBackupCreatedAt: timestamp,
    offsiteSuccessStateSha256: sha,
    offsiteCompletedAt: timestamp,
    wormReceiptSha256: sha,
    wormCompletedAt: timestamp,
    logicalWormRetrievalReceiptSha256: sha,
    logicalWormRetrievedAt: timestamp,
    privateStorageCaptureReceiptSha256: sha,
    privateStorageCapturedAt: timestamp,
    offsiteRetrievalReceiptSha256: sha,
    offsiteRetrievedAt: timestamp,
    logicalRestoreReceiptSha256: sha,
    logicalRestoreRestoredAt: timestamp,
    privateStorageRestoreReceiptSha256: sha,
    privateStorageRestoredAt: timestamp,
    deletionReplayFirstReceiptSha256: sha,
    deletionReplaySecondReceiptSha256: sha,
    deletionReplayCompletedAt: timestamp,
    recoveryStartedAt: timestamp,
    applicationReadyAt: timestamp,
    recoveredApplicationCompletedAt: timestamp,
    cleanupStartedAt: timestamp,
    cleanupCompletedAt: timestamp,
    recoveryTargetIdentitySha256: sha,
    recoveryPointAt: timestamp,
    rpoSeconds: z.number().int().min(0).max(3_600),
    rtoSeconds: z.number().int().min(1).max(14_400),
    cleanupSeconds: z.number().int().min(0).max(3_600),
    reviewerApprovalSetSha256: sha,
    reviewerIdSha256s: z
      .tuple([sha, sha])
      .refine(
        ([first, second]) => first < second,
        "reviewer IDs must be distinct and bytewise sorted",
      ),
    attestedAt: timestamp,
    chronologySha256: sha,
    checks: productionPromotionRecoveryChecksSchema,
  })
  .strict();

export const productionPromotionRecoveryReceiptSchema = receiptWithoutHashSchema
  .extend({
    receiptSha256: sha,
  })
  .strict()
  .superRefine((value, context) => {
    const { receiptSha256, ...withoutHash } = value;
    if (sha256ProductionPromotionRecoveryValue(withoutHash) !== receiptSha256) {
      context.addIssue({ code: "custom", message: "receipt hash mismatch" });
    }
  });

export type ProductionPromotionRecoveryReceipt = z.infer<
  typeof productionPromotionRecoveryReceiptSchema
>;
export type ProductionPromotionRecoveryReceiptWithoutHash = z.infer<
  typeof receiptWithoutHashSchema
>;

export function sha256ProductionPromotionRecoveryBytes(
  value: crypto.BinaryLike,
): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256ProductionPromotionRecoveryValue(value: unknown): string {
  return sha256ProductionPromotionRecoveryBytes(
    canonicalPostgresBackupJson(value),
  );
}

export function buildProductionPromotionRecoveryReceipt(
  value: ProductionPromotionRecoveryReceiptWithoutHash,
): ProductionPromotionRecoveryReceipt {
  const checked = receiptWithoutHashSchema.parse(value);
  return productionPromotionRecoveryReceiptSchema.parse({
    ...checked,
    receiptSha256: sha256ProductionPromotionRecoveryValue(checked),
  });
}

export function parseProductionPromotionRecoveryReceipt(
  value: unknown,
): ProductionPromotionRecoveryReceipt {
  return productionPromotionRecoveryReceiptSchema.parse(value);
}

export function verifyProductionPromotionRecoveryApproval(input: {
  readonly approval: unknown;
  readonly authorityManifestSha256: string;
  readonly candidateSha: string;
  readonly publicKeyPem: Buffer;
}): ProductionPromotionRecoveryApproval {
  const approval = productionPromotionRecoveryApprovalSchema.parse(
    input.approval,
  );
  const publicKeySha256 = sha256ProductionPromotionRecoveryBytes(
    input.publicKeyPem,
  );
  if (
    approval.payload.authorityManifestSha256 !==
      input.authorityManifestSha256 ||
    approval.payload.candidateSha !== input.candidateSha ||
    approval.payload.reviewerPublicKeySha256 !== publicKeySha256
  )
    throw new Error("approval authority mismatch");
  const key = crypto.createPublicKey(input.publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("approval key mismatch");
  const signature = Buffer.from(approval.signatureBase64, "base64");
  const payload = Buffer.from(
    canonicalPostgresBackupJson(approval.payload),
    "utf8",
  );
  if (!crypto.verify(null, payload, key, signature))
    throw new Error("approval signature mismatch");
  return approval;
}
