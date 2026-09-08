import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  runProtectedPermanentStagingColdPrepare,
} from "../scripts/execute-protected-permanent-staging-cold-prepare.js";
import {
  runProtectedPermanentStagingColdQuiesce,
} from "../scripts/execute-protected-permanent-staging-cold-quiesce.js";
import {
  runPermanentStagingColdPrepareReconciliationProbe,
} from "../scripts/probe-permanent-staging-cold-prepare-reconciliation.js";
import {
  runPermanentStagingColdQuiesceReconciliationProbe,
} from "../scripts/probe-permanent-staging-cold-quiesce-reconciliation.js";
import {
  argumentsExact,
  COLD_QUIESCE_SUCCESSOR_BINDING,
  COLD_RECOVERY_EXTERNAL_MUTATION_FREEZE_ATTESTATION,
  COLD_RECOVERY_LOCK,
  COLD_RECOVERY_CLI_SHA256,
  COLD_RECOVERY_POLICY_SHA256,
  fullStateCanonical,
  parseColdQuiesceSuccessorBinding,
  parseSupabaseReplacementPrerequisite,
  policyExact,
  readPrivateEvidence,
  requiredRowsExact,
  type ColdRecoveryState,
  type ColdRecoveryVariableRow,
} from "../scripts/lib/permanent-staging-cold-recovery.js";
import {
  railwayEnvironmentPatchCommitVariables,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
  type RailwayEnvironmentPatchCommitAttempt,
} from "../scripts/lib/railway-environment-patch-commit.js";
import {
  STAGING_WORKER_BOOTSTRAP_PREREQUISITES_SCHEMA,
  STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256,
  stagingWorkerBootstrapPrerequisiteInternals,
} from "../scripts/verify-permanent-staging-worker-bootstrap-prerequisites.js";

const CANDIDATE = "a".repeat(40);
const OLD_SOURCE = COLD_RECOVERY_LOCK.sourceSha;
const PREPARE_RUN = "1000";
const REPLACEMENT_RUN = "500";
const CURRENT_RUN = "9000";
const NOW = Date.parse("2026-09-08T05:11:02.000Z");

function sha(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function row(
  name: string,
  isSealed = name === "SUPABASE_SERVICE_ROLE_KEY",
): ColdRecoveryVariableRow {
  return {
    id: `row-${name}`,
    name,
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    serviceId: COLD_RECOVERY_LOCK.serviceId,
    isSealed,
    references: [],
  };
}

const baseRows = [row("PUBLIC_BASE_URL"), row("SUPABASE_SERVICE_ROLE_KEY")];

function state(
  replicas: null | 0,
  maintenance: boolean,
): ColdRecoveryState {
  return {
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    serviceInstanceId: COLD_RECOVERY_LOCK.serviceInstanceId,
    serviceId: COLD_RECOVERY_LOCK.serviceId,
    numReplicas: replicas,
    configuredReplicas: replicas === null ? 1 : 0,
    configuredRegions: replicas === null
      ? [{ region: COLD_RECOVERY_LOCK.configuredRegionBefore, numReplicas: 1 }]
      : [],
    deploymentRegions: [{ region: COLD_RECOVERY_LOCK.region, numReplicas: 1 }],
    source: { repo: null, image: null },
    latestDeployment: {
      id: COLD_RECOVERY_LOCK.deploymentId,
      status: "FAILED",
      deploymentStopped: true,
      snapshotId: COLD_RECOVERY_LOCK.snapshotId,
    },
    activeDeployments: [],
    domains: [{
      kind: "service",
      id: COLD_RECOVERY_LOCK.domainId,
      domain: COLD_RECOVERY_LOCK.domain,
      targetPort: 8_080,
    }],
    deployment: {
      id: COLD_RECOVERY_LOCK.deploymentId,
      projectId: COLD_RECOVERY_LOCK.projectId,
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      snapshotId: COLD_RECOVERY_LOCK.snapshotId,
      commitHash: OLD_SOURCE,
      imageDigest: null,
      patchId: null,
    },
    rows: maintenance
      ? [
        ...baseRows,
        row("PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA"),
        row("PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED"),
      ]
      : baseRows,
  };
}

function scope(): Response {
  return new Response(JSON.stringify({
    data: {
      projectToken: {
        projectId: COLD_RECOVERY_LOCK.projectId,
        environmentId: COLD_RECOVERY_LOCK.environmentId,
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function directMutationAttempt(
  outcome: "acknowledged" | "provider_rejected" | "transport_uncertain",
): RailwayEnvironmentPatchCommitAttempt {
  const variables = railwayEnvironmentPatchCommitVariables({
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    serviceId: COLD_RECOVERY_LOCK.serviceId,
    regions: COLD_RECOVERY_LOCK.quiesceRegions.map((region) => ({
      region,
      numReplicas: 0,
    })),
    commitMessage: `PintPath cold quiesce ${CANDIDATE} run ${CURRENT_RUN}`,
  })!;
  return {
    outcome,
    operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
    querySha256: sha(RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION),
    variablesSha256: sha(JSON.stringify(variables)),
    requestBodySha256: sha(JSON.stringify({
      operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
      query: RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
      variables,
    })),
    responseBodySha256: outcome === "transport_uncertain" ? null : sha("response"),
    acknowledgementSha256: outcome === "acknowledged" ? sha("wf-1") : null,
    acknowledgementExact: outcome === "acknowledged",
    zeroRegionsEncodedAsJsonNull: true,
  };
}

function replacementReceipt(candidateSha = CANDIDATE): string {
  return canonical({
    schemaVersion: "pintpath-permanent-staging-variable-mutation-terminal/v4",
    receipt: {
      schemaVersion: "pintpath-permanent-staging-variable-mutation/v4",
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      operation: "supabase-key-replacement",
      outcome: "acknowledged_pending_runtime_proof",
      candidateSha,
      attempts: 1,
      retryAllowed: false,
      intentSha256: sha("replacement-intent"),
      terminalEvidenceSha256: null,
      externalMutationFreeze: {
        attestation:
          "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN",
        enforcement: "OPERATIONAL_NOT_PROVIDER_VERIFIED",
        providerCasOrLockVerified: false,
      },
      stagedDeletionPatchId: null,
      supabaseKeyCanary: {
        origin: "https://bbfibbadwjxzrcdncavy.supabase.co",
        publishableEndpoint: "/auth/v1/settings",
        secretEndpoint: "/rest/v1/profiles?select=id&limit=1",
        publishableHttpStatus: 200,
        secretHttpStatus: 200,
        checks: {
          replacementKeyShapesExact: true,
          replacementKeysDistinct: true,
          publishableAuthSettingsExact: true,
          secretProfilesRelationExact: true,
          exactInputPairUsed: true,
          evidenceSecretFreeExact: true,
        },
        secretMaterialIncluded: false,
        secretDerivedCommitmentsIncluded: false,
      },
      checks: {
        policyExact: true,
        githubAuthorityExact: true,
        externalMutationFreezeAttested: true,
        tokenScopesExact: true,
        boundaryPreflightExact: true,
        boundaryPrecommitExact: false,
        targetPreflightExact: true,
        supabasePairCanaryExact: true,
        durableIntentExact: true,
        mutationAttemptedAtMostOnce: true,
        acknowledgementExact: true,
        stageAcknowledgementExact: false,
        commitAcknowledgementExact: false,
        stagedDeletionPatchExact: false,
        committedDeletionPatchExact: false,
        deploySuppressionExact: true,
        postflightAttempted: true,
        targetPostflightExact: true,
        deploymentUnchanged: true,
        boundaryPostflightExact: true,
        inputZeroized: true,
        terminalEvidenceExact: false,
      },
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function coldPrepareVerification(
  operation: "cold-quiesce" | "cold-reconcile-quiesce" = "cold-quiesce",
): string {
  return canonical({
    schemaVersion: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_SCHEMA,
    policySha256: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256,
    operation,
    bootstrapPath: "cold-dead",
    candidateSha: CANDIDATE,
    expectedDeploymentSha: OLD_SOURCE,
    repository: "blackmagic30/Beer",
    reviewedPullRequest: {
      number: 1,
      reviewedHeadSha: "b".repeat(40),
      mergeCommitSha: CANDIDATE,
      treeSha: "c".repeat(40),
      mergedAt: "2026-09-08T04:35:00.000Z",
      authorId: 1,
      mergedById: 2,
    },
    consumer: {
      workflowPath: ".github/workflows/recover-permanent-staging-cold-zero.yml",
      githubEnvironment: "permanent-staging-scale-evidence",
      runId: CURRENT_RUN,
      runAttempt: 1,
      startedAt: "2026-09-08T05:10:30.000Z",
    },
    prerequisites: [{
      kind: "cold-prepare",
      workflowPath: ".github/workflows/recover-permanent-staging-cold-zero.yml",
      runId: PREPARE_RUN,
      runAttempt: 1,
      startedAt: "2026-09-08T05:00:00.000Z",
      completedAt: "2026-09-08T05:10:00.000Z",
      artifactName: `pintpath-permanent-staging-cold-prepare-${CANDIDATE}`,
      artifactId: "7000",
      artifactDigest: `sha256:${"d".repeat(64)}`,
      artifactSizeBytes: 2048,
      receipt: {
        filename: "cold-prepare-terminal.json",
        schemaVersion: "pintpath-permanent-staging-cold-prepare/v2",
        sha256: "e".repeat(64),
        outcome: "prepared_cold",
        candidateSha: CANDIDATE,
        sourceSha: OLD_SOURCE,
        deploymentIdSha256: "f".repeat(64),
        replicasBefore: 1,
        replicasAfter: 1,
      },
      prerequisiteVerificationSha256: null,
    }],
    verifiedAt: "2026-09-08T05:10:45.000Z",
    expiresAt: "2026-09-08T05:25:45.000Z",
    checks: {
      policiesExact: true,
      currentMainExact: true,
      reviewedCandidateExact: true,
      consumerRunAuthorityExact: true,
      prerequisiteRunsExact: true,
      artifactNamesAndDigestsExact: true,
      receiptSchemasAndBindingsExact: true,
      strictChronologyExact: true,
      noLaterMatchingRunsExact: true,
      evidenceSecretFreeExact: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function reconcileAuthority(priorRunId = "676"): string {
  return `${JSON.stringify({
    command: "verify-github-reviewed-candidate-authority",
    ok: true,
    schemaVersion: 1,
    kind: "pintpath-github-reviewed-candidate-authority",
    repository: "blackmagic30/Beer",
    candidateSha: CANDIDATE,
    reviewedPrHeadSha: "b".repeat(40),
    reviewedPullRequestNumber: 1,
    operation: "cold-recovery-reconcile-quiesce",
    workflowPath: ".github/workflows/recover-permanent-staging-cold-zero.yml",
    workflowRunId: CURRENT_RUN,
    workflowRunAttempt: 1,
    priorAmbiguousColdQuiesceRunId: priorRunId,
    selectedColdPrepareRunId: PREPARE_RUN,
    exactPriorColdQuiesceCandidateRunBound: true,
    secondColdScaleWritePreventedExact: true,
    runnerLossRecoveryOriginalRunCompletedAt: "2026-09-07T18:55:00.000Z",
    runnerLossRecoveryGraceHours: 24,
    runnerLossRecoveryWithinGraceExact: true,
    reviewedAuthorityExact: true,
    freshDispatchWriteGuardExact: true,
  })}\n`;
}

function reconcilePrepareAuthority(priorRunId = "673"): string {
  return `${JSON.stringify({
    command: "verify-github-reviewed-candidate-authority",
    ok: true,
    schemaVersion: 1,
    kind: "pintpath-github-reviewed-candidate-authority",
    repository: "blackmagic30/Beer",
    candidateSha: CANDIDATE,
    reviewedPrHeadSha: "b".repeat(40),
    reviewedPullRequestNumber: 1,
    operation: "cold-recovery-reconcile-prepare",
    workflowPath: ".github/workflows/recover-permanent-staging-cold-zero.yml",
    workflowRunId: CURRENT_RUN,
    workflowRunAttempt: 1,
    priorAmbiguousColdPrepareRunId: priorRunId,
    selectedSupabaseReplacementRunId: REPLACEMENT_RUN,
    exactPriorColdPrepareCandidateRunBound: true,
    secondColdPrepareWritePreventedExact: true,
    runnerLossRecoveryOriginalRunCompletedAt: "2026-09-07T18:55:00.000Z",
    runnerLossRecoveryGraceHours: 24,
    runnerLossRecoveryWithinGraceExact: true,
    reviewedAuthorityExact: true,
    freshDispatchWriteGuardExact: true,
  })}\n`;
}

function environment(operation: "prepare" | "quiesce") {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "blackmagic30/Beer",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CANDIDATE,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: CURRENT_RUN,
    PINTPATH_PROTECTED_ENVIRONMENT: operation === "prepare"
      ? "permanent-staging-provider-mutation"
      : "permanent-staging-scale-evidence",
    PINTPATH_COLD_RECOVERY_CONFIRMATION: operation === "prepare"
      ? `PREPARE_PERMANENT_STAGING_COLD_RECOVERY_FOR_${CANDIDATE}_FROM_${OLD_SOURCE}`
      : `QUIESCE_PERMANENT_STAGING_COLD_RECOVERY_TO_ZERO_FOR_${CANDIDATE}_FROM_${OLD_SOURCE}`,
    PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION:
      COLD_RECOVERY_EXTERNAL_MUTATION_FREEZE_ATTESTATION,
    PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN: "production-metadata-token-long-enough",
    PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "staging-metadata-token-long-enough",
    PINTPATH_RAILWAY_STAGING_VARIABLE_TOKEN: "staging-variable-token-long-enough",
    PINTPATH_RAILWAY_STAGING_SCALE_TOKEN: "staging-scale-token-long-enough",
    PINTPATH_RAILWAY_CLI_PATH: "/private/railway",
  };
}

function coldQuiesceSuccessorAuthority(currentRunId = CURRENT_RUN): string {
  return `${JSON.stringify({
    command: "verify-github-reviewed-candidate-authority",
    ok: true,
    schemaVersion: 1,
    kind: "pintpath-github-reviewed-candidate-authority",
    repository: "blackmagic30/Beer",
    candidateSha: CANDIDATE,
    operation: "cold-recovery-successor-quiesce",
    workflowPath: ".github/workflows/recover-permanent-staging-cold-zero.yml",
    workflowRunId: currentRunId,
    workflowRunAttempt: 1,
    selectedColdPrepareRunId: PREPARE_RUN,
    selectedColdPrepareRunStartedAt: "2026-09-08T05:00:00.000Z",
    selectedColdPrepareRunCompletedAt: "2026-09-08T05:10:00.000Z",
    selectedReplacementRunId: REPLACEMENT_RUN,
    selectedReplacementRunStartedAt: "2026-09-08T04:40:00.000Z",
    selectedReplacementRunCompletedAt: "2026-09-08T04:50:00.000Z",
    priorAmbiguousColdQuiesceCandidateSha:
      COLD_QUIESCE_SUCCESSOR_BINDING.priorCandidateSha,
    priorAmbiguousColdQuiesceReviewedHeadSha:
      COLD_QUIESCE_SUCCESSOR_BINDING.priorReviewedHeadSha,
    priorAmbiguousColdQuiesceTreeSha:
      COLD_QUIESCE_SUCCESSOR_BINDING.priorTreeSha,
    priorAmbiguousColdQuiescePullRequestNumber:
      COLD_QUIESCE_SUCCESSOR_BINDING.priorPullRequestNumber,
    priorAmbiguousColdQuiesceCandidateMergedAt:
      COLD_QUIESCE_SUCCESSOR_BINDING.priorMergedAt,
    priorColdPrepareRunId:
      COLD_QUIESCE_SUCCESSOR_BINDING.priorPrepareRunId,
    priorAmbiguousColdQuiesceRunId:
      COLD_QUIESCE_SUCCESSOR_BINDING.priorQuiesceRunId,
    priorAmbiguousColdQuiesceArtifactId:
      COLD_QUIESCE_SUCCESSOR_BINDING.priorArtifactId,
    priorAmbiguousColdQuiesceArtifactName:
      COLD_QUIESCE_SUCCESSOR_BINDING.priorArtifactName,
    priorAmbiguousColdQuiesceArtifactDigest:
      COLD_QUIESCE_SUCCESSOR_BINDING.priorArtifactDigest,
    legacyColdRecoveryCandidateSha:
      COLD_QUIESCE_SUCCESSOR_BINDING.legacyCandidateSha,
    legacyColdRecoveryReviewedHeadSha:
      COLD_QUIESCE_SUCCESSOR_BINDING.legacyReviewedHeadSha,
    legacyColdRecoveryTreeSha: COLD_QUIESCE_SUCCESSOR_BINDING.legacyTreeSha,
    legacyColdRecoveryPullRequestNumber:
      COLD_QUIESCE_SUCCESSOR_BINDING.legacyPullRequestNumber,
    legacyColdRecoveryCandidateMergedAt:
      COLD_QUIESCE_SUCCESSOR_BINDING.legacyMergedAt,
    legacyColdPrepareRunId: COLD_QUIESCE_SUCCESSOR_BINDING.legacyPrepareRunId,
    legacyColdQuiesceRunId: COLD_QUIESCE_SUCCESSOR_BINDING.legacyQuiesceRunId,
    legacyColdQuiesceRunCompletedAt:
      COLD_QUIESCE_SUCCESSOR_BINDING.legacyQuiesceRunCompletedAt,
    legacyFailedReadOnlyColdQuiesceReconcileRunId:
      COLD_QUIESCE_SUCCESSOR_BINDING.legacyReadOnlyReconcileRunId,
    legacyAmbiguousColdQuiesceArtifactId:
      COLD_QUIESCE_SUCCESSOR_BINDING.legacyArtifactId,
    legacyAmbiguousColdQuiesceArtifactName:
      COLD_QUIESCE_SUCCESSOR_BINDING.legacyArtifactName,
    legacyAmbiguousColdQuiesceArtifactDigest:
      COLD_QUIESCE_SUCCESSOR_BINDING.legacyArtifactDigest,
    priorAmbiguousColdQuiesceRunCompletedAt:
      COLD_QUIESCE_SUCCESSOR_BINDING.priorCompletedAt,
    intermediateColdRecoveryCandidateSha:
      COLD_QUIESCE_SUCCESSOR_BINDING.intermediateCandidateSha,
    intermediateColdRecoveryReviewedHeadSha:
      COLD_QUIESCE_SUCCESSOR_BINDING.intermediateReviewedHeadSha,
    intermediateColdRecoveryTreeSha:
      COLD_QUIESCE_SUCCESSOR_BINDING.intermediateTreeSha,
    intermediateColdRecoveryPullRequestNumber:
      COLD_QUIESCE_SUCCESSOR_BINDING.intermediatePullRequestNumber,
    intermediateColdRecoveryCandidateMergedAt:
      COLD_QUIESCE_SUCCESSOR_BINDING.intermediateMergedAt,
    intermediateAmbiguousColdPrepareRunId:
      COLD_QUIESCE_SUCCESSOR_BINDING.intermediateAmbiguousPrepareRunId,
    intermediateFailedReadOnlyColdPrepareReconcileRunId:
      COLD_QUIESCE_SUCCESSOR_BINDING
        .intermediateFailedReadOnlyPrepareReconcileRunId,
    coldQuiesceSuccessorGraceHours: 24,
    coldQuiesceSuccessorDeadline: COLD_QUIESCE_SUCCESSOR_BINDING.deadline,
    coldQuiesceSuccessorWithinGraceExact: true,
    coldQuiesceSuccessorDirectParentExact: true,
    coldQuiesceSuccessorLegacyHistoryExact: true,
    coldQuiesceSuccessorPriorHistoryExact: true,
    coldQuiesceSuccessorAllRefsHistoryExact: true,
    coldQuiesceSuccessorCurrentPrepareExact: true,
    coldQuiesceSuccessorLegacyArtifactMetadataExact: true,
    coldQuiesceSuccessorPriorArtifactMetadataExact: true,
    coldQuiesceSuccessorPriorProviderProofRequired: true,
    coldQuiesceSuccessorLegacyToIntermediateParentExact: true,
    coldQuiesceSuccessorIntermediateToPriorParentExact: true,
    coldQuiesceSuccessorCompleteFourCandidateLineageExact: true,
    coldQuiesceSuccessorIntermediateHistoryExact: true,
    coldQuiesceSuccessorBridgeRequired: true,
    completeRetainedHistoryExact: true,
    stagingLifecycleSealed: false,
    reviewedAuthorityExact: true,
    freshDispatchWriteGuardExact: true,
  })}\n`;
}

function coldQuiesceSuccessorBridge(currentRunId = CURRENT_RUN): string {
  const authoritySource = coldQuiesceSuccessorAuthority(currentRunId);
  return canonical({
    schemaVersion: COLD_QUIESCE_SUCCESSOR_BINDING.bridgeSchema,
    operation: COLD_QUIESCE_SUCCESSOR_BINDING.bridgeOperation,
    candidateSha: CANDIDATE,
    currentRunId,
    currentPrepareRunId: PREPARE_RUN,
    sourceSha: OLD_SOURCE,
    priorCandidateSha: COLD_QUIESCE_SUCCESSOR_BINDING.priorCandidateSha,
    priorQuiesceRunId: COLD_QUIESCE_SUCCESSOR_BINDING.priorQuiesceRunId,
    legacyCandidate: {
      candidateSha: COLD_QUIESCE_SUCCESSOR_BINDING.legacyCandidateSha,
      reviewedHeadSha: COLD_QUIESCE_SUCCESSOR_BINDING.legacyReviewedHeadSha,
      treeSha: COLD_QUIESCE_SUCCESSOR_BINDING.legacyTreeSha,
      pullRequestNumber: COLD_QUIESCE_SUCCESSOR_BINDING.legacyPullRequestNumber,
      mergedAt: COLD_QUIESCE_SUCCESSOR_BINDING.legacyMergedAt,
      prepareRunId: COLD_QUIESCE_SUCCESSOR_BINDING.legacyPrepareRunId,
      quiesceRunId: COLD_QUIESCE_SUCCESSOR_BINDING.legacyQuiesceRunId,
      quiesceRunCompletedAt:
        COLD_QUIESCE_SUCCESSOR_BINDING.legacyQuiesceRunCompletedAt,
      failedReadOnlyReconcileRunId:
        COLD_QUIESCE_SUCCESSOR_BINDING.legacyReadOnlyReconcileRunId,
    },
    intermediateCandidate: {
      candidateSha: COLD_QUIESCE_SUCCESSOR_BINDING.intermediateCandidateSha,
      reviewedHeadSha:
        COLD_QUIESCE_SUCCESSOR_BINDING.intermediateReviewedHeadSha,
      treeSha: COLD_QUIESCE_SUCCESSOR_BINDING.intermediateTreeSha,
      pullRequestNumber:
        COLD_QUIESCE_SUCCESSOR_BINDING.intermediatePullRequestNumber,
      mergedAt: COLD_QUIESCE_SUCCESSOR_BINDING.intermediateMergedAt,
      ambiguousPrepareRunId:
        COLD_QUIESCE_SUCCESSOR_BINDING.intermediateAmbiguousPrepareRunId,
      failedReadOnlyPrepareReconcileRunId:
        COLD_QUIESCE_SUCCESSOR_BINDING
          .intermediateFailedReadOnlyPrepareReconcileRunId,
    },
    legacyArtifact: {
      id: COLD_QUIESCE_SUCCESSOR_BINDING.legacyArtifactId,
      name: COLD_QUIESCE_SUCCESSOR_BINDING.legacyArtifactName,
      digest: COLD_QUIESCE_SUCCESSOR_BINDING.legacyArtifactDigest,
      receiptSha256: COLD_QUIESCE_SUCCESSOR_BINDING.legacyReceiptSha256,
      intentSha256: COLD_QUIESCE_SUCCESSOR_BINDING.legacyIntentSha256,
      prerequisitesSha256:
        COLD_QUIESCE_SUCCESSOR_BINDING.legacyPrerequisitesSha256,
      priorReviewedAuthoritySha256:
        COLD_QUIESCE_SUCCESSOR_BINDING.legacyReviewedAuthoritySha256,
    },
    priorArtifact: {
      id: COLD_QUIESCE_SUCCESSOR_BINDING.priorArtifactId,
      name: COLD_QUIESCE_SUCCESSOR_BINDING.priorArtifactName,
      digest: COLD_QUIESCE_SUCCESSOR_BINDING.priorArtifactDigest,
      receiptSha256: COLD_QUIESCE_SUCCESSOR_BINDING.priorReceiptSha256,
      intentSha256: COLD_QUIESCE_SUCCESSOR_BINDING.priorIntentSha256,
      successorBridgeSha256: COLD_QUIESCE_SUCCESSOR_BINDING.priorBridgeSha256,
      prerequisitesSha256:
        COLD_QUIESCE_SUCCESSOR_BINDING.priorPrerequisitesSha256,
      reviewedAuthoritySha256:
        COLD_QUIESCE_SUCCESSOR_BINDING.priorReviewedAuthoritySha256,
    },
    priorCliFailure: {
      cliVersion: "5.32.0",
      cliSha256: COLD_RECOVERY_CLI_SHA256,
      cliExitCode: 1,
      timedOut: false,
      stdoutSha256: sha(""),
      stderrSha256: COLD_QUIESCE_SUCCESSOR_BINDING.priorCliStderrSha256,
      normalizedErrorSha256:
        COLD_QUIESCE_SUCCESSOR_BINDING.priorCliStderrSha256,
      clapParseFailure: false,
      renderedErrorKind: "UnauthorizedToken",
      graphqlAuthorizationDenied: true,
      deniedResolver: null,
      resolverUnknown: true,
      environmentPatchCommitReached: null,
    },
    providerWriteCommitted: false,
    mutationExclusivity: {
      externalMutationFreezeAttestation:
        COLD_RECOVERY_EXTERNAL_MUTATION_FREEZE_ATTESTATION,
      enforcement: "OPERATIONAL_NOT_PROVIDER_VERIFIED",
      concurrencyGroup: "pintpath-permanent-staging-key-rollout",
      cancelInProgress: false,
      bridgeTokenCustody: "METADATA_ONLY",
      mutationTokenPresent: false,
    },
    currentPrepare: {
      runId: PREPARE_RUN,
      terminalSha256: "c".repeat(64),
      replacementRunId: REPLACEMENT_RUN,
      startedAt: "2026-09-08T05:00:00.000Z",
      completedAt: "2026-09-08T05:10:00.000Z",
    },
    providerNoWriteProof: {
      schemaVersion:
        "pintpath-permanent-staging-cold-provider-no-write-proof/v1",
      observedAt: "2026-09-08T05:11:01.000Z",
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      querySha256: {
        history: COLD_QUIESCE_SUCCESSOR_BINDING.providerHistoryQuerySha256,
        patches: COLD_QUIESCE_SUCCESSOR_BINDING.providerPatchesQuerySha256,
        patch: COLD_QUIESCE_SUCCESSOR_BINDING.providerPatchQuerySha256,
      },
      history: {
        pages: [{
          requestAfter: null,
          count: 8,
          endCursor: "history-terminal-cursor",
          hasNextPage: false,
        }],
        count: 8,
        rowsSha256: "4".repeat(64),
        prefixCount: 6,
        prefixRowsSha256:
          "f1270eaf4378364f1d91624515f7a0b370f9274254535619704a56d948bf609f",
        suffixEventIds: [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ],
      },
      patches: {
        pages: [{
          requestAfter: null,
          count: 100,
          endCursor: "patch-page-one-cursor",
          hasNextPage: true,
        }, {
          requestAfter: "patch-page-one-cursor",
          count: 24,
          endCursor: "patch-terminal-cursor",
          hasNextPage: false,
        }],
        count: 124,
        rowsSha256: "5".repeat(64),
        prefixCount: 122,
        prefixRowsSha256:
          "a560f185f77fb091da39314eb1f7f9f5ab3a4d2f6593752339649751f6c133db",
        suffixPatchIds: [
          "33333333-3333-4333-8333-333333333333",
          "44444444-4444-4444-8444-444444444444",
        ],
        crossFetchProjectionSha256: "6".repeat(64),
      },
      incidentWindows: [{
        startedAt: "2026-09-07T18:51:21.000Z",
        completedAt: "2026-09-07T18:57:20.000Z",
      }, {
        startedAt: "2026-09-08T04:30:38.868Z",
        completedAt: "2026-09-08T04:32:22.210Z",
      }],
      liveStateSha256: sha(fullStateCanonical(state(null, true))),
      checks: {
        paginationCompleteExact: true,
        chronologicalOrderExact: true,
        historicalPrefixesExact: true,
        historicalScalePositiveControlExact: true,
        legacyUnauthorizedRunNoWriteExact: true,
        priorUnauthorizedRunNoWriteExact: true,
        authorizedSuffixExact: true,
        targetDeployAbsentFromSuffixExact: true,
        crossFetchedPatchesExact: true,
        ledgerRecheckExact: true,
        liveTopologyContinuityExact: true,
      },
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    },
    sourceProof: {
      commandProducer: {
        repository: "blackmagic30/Beer",
        candidateSha: COLD_QUIESCE_SUCCESSOR_BINDING.priorCandidateSha,
        path: "scripts/lib/permanent-staging-cold-recovery.ts",
        gitBlobSha: COLD_QUIESCE_SUCCESSOR_BINDING.commandProducerGitBlobSha,
        sha256: COLD_QUIESCE_SUCCESSOR_BINDING.commandProducerSha256,
      },
      railwayCli: {
        repository: "railwayapp/cli",
        version: "5.32.0",
        tag: "v5.32.0",
        tagCommitSha: COLD_QUIESCE_SUCCESSOR_BINDING.railwayCliTagCommitSha,
        main: {
          path: "src/main.rs",
          gitBlobSha: COLD_QUIESCE_SUCCESSOR_BINDING.railwayCliMainGitBlobSha,
          sha256: COLD_QUIESCE_SUCCESSOR_BINDING.railwayCliMainSha256,
        },
        scale: {
          path: "src/commands/scale.rs",
          gitBlobSha: COLD_QUIESCE_SUCCESSOR_BINDING.railwayCliScaleGitBlobSha,
          sha256: COLD_QUIESCE_SUCCESSOR_BINDING.railwayCliScaleSha256,
        },
        regions: {
          path: "src/controllers/regions.rs",
          gitBlobSha:
            COLD_QUIESCE_SUCCESSOR_BINDING.railwayCliRegionsGitBlobSha,
          sha256: COLD_QUIESCE_SUCCESSOR_BINDING.railwayCliRegionsSha256,
        },
        client: {
          path: "src/client.rs",
          gitBlobSha: COLD_QUIESCE_SUCCESSOR_BINDING.railwayCliClientGitBlobSha,
          sha256: COLD_QUIESCE_SUCCESSOR_BINDING.railwayCliClientSha256,
        },
        errors: {
          path: "src/errors.rs",
          gitBlobSha: COLD_QUIESCE_SUCCESSOR_BINDING.railwayCliErrorsGitBlobSha,
          sha256: COLD_QUIESCE_SUCCESSOR_BINDING.railwayCliErrorsSha256,
        },
        environmentPatchCommit: {
          path: "src/gql/mutations/strings/EnvironmentPatchCommit.graphql",
          gitBlobSha:
            COLD_QUIESCE_SUCCESSOR_BINDING
              .railwayCliEnvironmentPatchCommitGitBlobSha,
          sha256:
            COLD_QUIESCE_SUCCESSOR_BINDING
              .railwayCliEnvironmentPatchCommitSha256,
        },
      },
    },
    liveTopology: {
      configuredReplicas: 1,
      configuredRegions: [{
        region: COLD_RECOVERY_LOCK.configuredRegionBefore,
        numReplicas: 1,
      }],
      legacyAggregateReplicas: null,
      deploymentManifestRegions: [{
        region: COLD_RECOVERY_LOCK.region,
        numReplicas: 1,
      }],
      liveStateSha256: sha(fullStateCanonical(state(null, true))),
    },
    reviewedAuthoritySha256: sha(authoritySource),
    priorAmbiguousColdQuiesceRunCompletedAt:
      COLD_QUIESCE_SUCCESSOR_BINDING.priorCompletedAt,
    coldQuiesceSuccessorGraceHours: 24,
    coldQuiesceSuccessorDeadline: COLD_QUIESCE_SUCCESSOR_BINDING.deadline,
    coldQuiesceSuccessorWithinGraceExact: true,
    verifiedAt: "2026-09-08T05:11:01.000Z",
    checks: {
      reviewedSuccessorAuthorityExact: true,
      directSuccessorLineageExact: true,
      legacyToIntermediateLineageExact: true,
      intermediateToPriorLineageExact: true,
      completeFourCandidateLineageExact: true,
      legacyColdHistoryExact: true,
      intermediateColdHistoryExact: true,
      priorColdHistoryExact: true,
      legacyArtifactMetadataExact: true,
      legacyArtifactContentsExact: true,
      priorArtifactMetadataExact: true,
      priorArtifactContentsExact: true,
      currentPrepareTerminalExact: true,
      sourceAnchorsExact: true,
      priorCliGraphqlAuthorizationFailureExact: true,
      providerHistoryCompleteExact: true,
      providerNoWriteExact: true,
      externalMutationFreezeAttested: true,
      serializedMutationConcurrencyExact: true,
      metadataOnlyTokenCustodyExact: true,
      readOnlyTokenScopeExact: true,
      configuredLiveTopologyExact: true,
      deploymentManifestIdentityExact: true,
      noProviderMutationPerformed: true,
    },
    nextRequiredProof: "FRESH_REVIEWED_SUCCESSOR_CONFIGURED_ONE_TO_ZERO",
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function reconcileEnvironment() {
  return {
    ...environment("quiesce"),
    PINTPATH_COLD_RECOVERY_CONFIRMATION:
      `RECONCILE_PERMANENT_STAGING_COLD_RECOVERY_AT_ZERO_FOR_${CANDIDATE}_FROM_${OLD_SOURCE}`,
    PINTPATH_RAILWAY_STAGING_SCALE_TOKEN: undefined,
    PINTPATH_RAILWAY_STAGING_VARIABLE_TOKEN: undefined,
  };
}

function reconcilePrepareEnvironment() {
  return {
    ...environment("prepare"),
    PINTPATH_COLD_RECOVERY_CONFIRMATION:
      `RECONCILE_PERMANENT_STAGING_COLD_PREPARE_FOR_${CANDIDATE}_FROM_${OLD_SOURCE}`,
    PINTPATH_RAILWAY_STAGING_VARIABLE_TOKEN: undefined,
    PINTPATH_RAILWAY_STAGING_SCALE_TOKEN: undefined,
    PINTPATH_RAILWAY_CLI_PATH: undefined,
  };
}

describe("permanent-staging cold recovery", () => {
  it("accepts a legitimate database-service DATABASE_URL without accepting a shared shadow", () => {
    const requiredRows: ColdRecoveryVariableRow[] = [
      {
        ...row("DATABASE_URL", true),
        references: [
          "c454955f-263b-4599-aee0-dc447a4d3d15.PINTPATH_RUNTIME_DATABASE_URL",
        ],
      },
      {
        ...row("REDIS_URL", true),
        references: ["d6351cec-fe04-4a6f-8e05-1cc164ea1e73.REDIS_URL"],
      },
      ...[
        "ALCOHOL_GAMIFICATION_ENABLED",
        "CONSUMER_PAID_ENROLLMENT_ENABLED",
        "GOOGLE_MAPS_API_KEY",
        "GOOGLE_MAPS_MAP_ID",
        "GOOGLE_PLACES_API_KEY",
        "OPENAI_API_KEY",
        "PINT_POINTS_REWARDS_ENABLED",
        "PUBLIC_BASE_URL",
        "REPORT_DELIVERY_SCHEDULE_ENABLED",
        "SUPABASE_ANON_KEY",
        "SUPABASE_RESULTS_TABLE",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_URL",
      ].map((name) => row(name)),
      {
        ...row("DATABASE_URL", true),
        id: "postgres-service-database-url",
        serviceId: "c454955f-263b-4599-aee0-dc447a4d3d15",
        references: [],
      },
    ];
    expect(requiredRowsExact(requiredRows)).toBe(true);
    expect(requiredRowsExact([
      ...requiredRows,
      {
        ...row("DATABASE_URL", true),
        id: "shared-database-url-shadow",
        serviceId: null,
        references: [
          "c454955f-263b-4599-aee0-dc447a4d3d15.PINTPATH_RUNTIME_DATABASE_URL",
        ],
      },
    ])).toBe(false);
  });

  it("accepts the complete audited 99-row inventory after only the three revoked off-site rows are absent", () => {
    const fixture = JSON.parse(fs.readFileSync(path.resolve(
      "test/fixtures/permanent-staging-offsite-cleanup-preflight-provider-snapshot.json",
    ), "utf8")) as { variables: ColdRecoveryVariableRow[] };
    expect(fixture.variables).toHaveLength(99);
    const forbidden = new Set([
      "OFFSITE_BACKUP_BUCKET",
      "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
      "OFFSITE_BACKUP_SUPABASE_URL",
    ]);
    const reconciled = fixture.variables.filter((item) =>
      !forbidden.has(item.name)
    );
    expect(reconciled).toHaveLength(96);
    expect(requiredRowsExact(reconciled)).toBe(true);
    expect(requiredRowsExact([
      ...reconciled,
      {
        id: "shared-database-url-shadow",
        name: "DATABASE_URL",
        environmentId: COLD_RECOVERY_LOCK.environmentId,
        serviceId: null,
        isSealed: false,
        references: [],
      },
    ])).toBe(false);
  });

  it("binds prepare to the exact replacement artifact without a second key pair", () => {
    const workflow = fs.readFileSync(
      ".github/workflows/recover-permanent-staging-cold-zero.yml",
      "utf8",
    );
    expect(workflow).toContain("replacement_run_id:");
    expect(workflow).toContain(
      "pintpath-permanent-staging-provider-mutation-supabase-key-replacement-${{ inputs.candidate_sha }}",
    );
    expect(workflow).toContain(
      '--replacement-terminal-file "$RUNNER_TEMP/pintpath-cold-replacement-prerequisite/sealed/terminal.json"',
    );
    expect(workflow).not.toContain("PINTPATH_SUPABASE_STAGING_NEW_SECRET_KEY");
    expect(workflow).not.toContain("PINTPATH_SUPABASE_STAGING_NEW_PUBLISHABLE_KEY");
    expect(workflow).toContain('GITHUB_ACTIONS: "true"');
    expect(workflow).not.toContain("github.actions");
    expect(workflow).toContain("ambiguous_quiesce_candidate_sha:");
    expect(workflow).toContain("external_mutation_freeze_attestation:");
    expect(workflow).toContain(
      "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN",
    );
    const quiesceJob = workflow.split("\n  quiesce:")[1]
      .split("\n  reconcile-quiesce:")[0];
    expect(quiesceJob).toContain('test -z "$AMBIGUOUS_PREPARE_RUN_ID"');
    expect(quiesceJob).toContain(
      "1161e7ecd421556b104bcae059e8764ebf4a545e",
    );
    expect(quiesceJob).toContain(
      'test "$AMBIGUOUS_QUIESCE_RUN_ID" = 34186930666',
    );
    expect(quiesceJob).toContain(
      '"$RUNNER_TEMP/pintpath-cold-prior/sealed"',
    );
    expect(quiesceJob).toContain(
      '"$RUNNER_TEMP/pintpath-cold-legacy/sealed"',
    );
    expect(quiesceJob).not.toContain("pintpath-cold-successor-bridge");
    expect(quiesceJob).not.toContain("pintpath-cold-failed-successor");
    expect(quiesceJob).toContain(
      "--operation cold-recovery-successor-quiesce",
    );
    expect(quiesceJob).toContain(
      "scripts/verify-permanent-staging-cold-quiesce-successor-bridge.ts",
    );
    expect(quiesceJob).toContain(
      '--prior-quiesce-run-id "$AMBIGUOUS_QUIESCE_RUN_ID"',
    );
    expect(quiesceJob).toContain(
      '--legacy-artifact-dir "$RUNNER_TEMP/pintpath-cold-legacy/sealed"',
    );
    expect(quiesceJob).toContain(
      '--prior-artifact-dir "$RUNNER_TEMP/pintpath-cold-prior/sealed"',
    );
    expect(quiesceJob).toContain(
      '--successor-bridge-file "$RUNNER_TEMP/pintpath-permanent-staging-cold-evidence/cold-quiesce-successor-bridge.json"',
    );
    expect(quiesceJob).toContain(
      '--reviewed-authority-file "$RUNNER_TEMP/pintpath-cold-github-candidate/reviewed-authority.json"',
    );
    const bridgeStep = quiesceJob.split(
      "- name: Bind the ambiguous predecessor to configured live topology",
    )[1].split("\n      - name:")[0];
    expect(bridgeStep).not.toContain("PINTPATH_RAILWAY_STAGING_SCALE_TOKEN");
    expect(bridgeStep).not.toContain("PINTPATH_RAILWAY_STAGING_VARIABLE_TOKEN");
    expect(bridgeStep).toContain(
      "PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION: ${{ inputs.external_mutation_freeze_attestation }}",
    );
    expect(workflow).toContain("group: pintpath-permanent-staging-key-rollout");
    expect(workflow).toContain("cancel-in-progress: false");
    const reconcileJob = workflow.split("\n  reconcile-quiesce:")[1];
    expect(reconcileJob).toContain('test -z "$AMBIGUOUS_PREPARE_RUN_ID"');
    expect(reconcileJob).toContain(
      "Prove the ambiguous cold quiesce reached exact zero without a second write",
    );
    expect(reconcileJob).toContain(
      "name: pintpath-permanent-staging-cold-quiesce-${{ inputs.candidate_sha }}",
    );
    expect(reconcileJob).toContain(
      "- name: Seal the exact successor bridge continuity evidence",
    );
    expect(reconcileJob).toContain(
      'cmp --silent -- "${matches[0]}" "$root/sealed/$leaf"',
    );
    expect(reconcileJob).toContain('chmod 400 "$root/sealed/$leaf"');
    expect(reconcileJob).toContain(
      "cold-quiesce-successor-bridge.json \\",
    );
    expect(reconcileJob).toContain(
      '--successor-bridge-file "$RUNNER_TEMP/pintpath-cold-reconcile-successor-bridge/sealed/cold-quiesce-successor-bridge.json"',
    );
    expect(reconcileJob).toContain(
      '--successor-reviewed-authority-file "$RUNNER_TEMP/pintpath-cold-reconcile-successor-bridge/sealed/reviewed-authority.json"',
    );
    expect(reconcileJob).toContain(
      "- name: Remove successor bridge continuity custody",
    );
    expect(reconcileJob).not.toContain("PINTPATH_RAILWAY_STAGING_SCALE_TOKEN");
    expect(reconcileJob).not.toContain("PINTPATH_RAILWAY_CLI_PATH");
    expect(reconcileJob).toContain(
      'test -z "$AMBIGUOUS_QUIESCE_CANDIDATE_SHA"',
    );
    const reconcilePrepareJob = workflow.split("\n  reconcile-prepare:")[1]
      .split("\n  quiesce:")[0];
    const reconcilePrepareAuthorityStep = reconcilePrepareJob.split(
      "- name: Authenticate the prior ambiguous prepare and current read-only dispatch",
    )[1].split("\n      - name:")[0];
    expect(reconcilePrepareAuthorityStep).toContain("umask 077");
    expect(reconcilePrepareAuthorityStep).toContain(
      '> "$RUNNER_TEMP/pintpath-cold-github-candidate/reviewed-authority.json"\n' +
        '          chmod 600 "$RUNNER_TEMP/pintpath-cold-github-candidate/reviewed-authority.json"',
    );
    expect(reconcilePrepareJob).toContain(
      "Prove the lost prepare acknowledgement without another write",
    );
    expect(reconcilePrepareJob).not.toContain(
      "PINTPATH_RAILWAY_STAGING_VARIABLE_TOKEN",
    );
  });

  it("rejects public reconciliation authority custody and accepts mode 0600", () => {
    const directory = fs.realpathSync(fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-cold-authority-mode-"),
    ));
    const filename = path.join(directory, "reviewed-authority.json");
    const source = `${JSON.stringify({ ok: true })}\n`;
    try {
      fs.writeFileSync(filename, source, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(filename, 0o644);
      expect(() => readPrivateEvidence(filename)).toThrow(
        "trusted_file_invalid",
      );
      fs.chmodSync(filename, 0o600);
      expect(readPrivateEvidence(filename)).toBe(source);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("pins the exact dead baseline and exact replacement receipt for prepare", () => {
    expect(policyExact(process.cwd())).toBe(true);
    expect(COLD_RECOVERY_POLICY_SHA256).toMatch(/^[a-f0-9]{64}$/);
    const policy = JSON.parse(fs.readFileSync(
      "ops/railway/permanent-staging-cold-recovery-policy.json",
      "utf8",
    )) as {
      operations: {
        quiesce: { configuredOneToZeroReceiptClaimed: boolean };
        reconcileQuiesce: { configuredOneToZeroReceiptClaimed: boolean };
      };
    };
    expect(policy.operations.quiesce.configuredOneToZeroReceiptClaimed)
      .toBe(true);
    expect(policy.operations.reconcileQuiesce.configuredOneToZeroReceiptClaimed)
      .toBe(false);
    expect(argumentsExact([
      "--candidate-sha", CANDIDATE,
      "--expected-deployment-sha", OLD_SOURCE,
      "--replacement-run-id", REPLACEMENT_RUN,
      "--replacement-terminal-file", "/private/terminal.json",
      "--evidence-dir", "/private/evidence",
    ], false)).not.toBeNull();
    expect(argumentsExact([
      "--candidate-sha", CANDIDATE,
      "--expected-deployment-sha", "b".repeat(40),
      "--replacement-run-id", REPLACEMENT_RUN,
      "--replacement-terminal-file", "/private/terminal.json",
      "--evidence-dir", "/private/evidence",
    ], false)).toBeNull();
    expect(parseSupabaseReplacementPrerequisite(
      replacementReceipt(),
      CANDIDATE,
    )).toMatchObject({ candidateSha: CANDIDATE });
    expect(parseSupabaseReplacementPrerequisite(
      replacementReceipt("b".repeat(40)),
      CANDIDATE,
    )).toBeNull();
    const unverifiedFreeze = JSON.parse(replacementReceipt()) as {
      receipt: {
        externalMutationFreeze: { attestation: string | null };
      };
    };
    unverifiedFreeze.receipt.externalMutationFreeze.attestation = null;
    expect(parseSupabaseReplacementPrerequisite(
      canonical(unverifiedFreeze),
      CANDIDATE,
    )).toBeNull();
    const legacySchema = JSON.parse(replacementReceipt()) as {
      schemaVersion: string;
    };
    legacySchema.schemaVersion =
      "pintpath-permanent-staging-variable-mutation-terminal/v3";
    expect(parseSupabaseReplacementPrerequisite(
      canonical(legacySchema),
      CANDIDATE,
    )).toBeNull();
  });

  it("prepares only the null/failed/source-disconnected baseline once", async () => {
    const before = state(null, false);
    const after = state(null, true);
    const readState = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { variableCollectionUpsert: true },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const evidence = new Map<string, string>();
    const output: string[] = [];
    const code = await runProtectedPermanentStagingColdPrepare({
      argv: [
        "--candidate-sha", CANDIDATE,
        "--expected-deployment-sha", OLD_SOURCE,
        "--replacement-run-id", REPLACEMENT_RUN,
        "--replacement-terminal-file", "/private/terminal.json",
        "--evidence-dir", "/private/evidence",
      ],
      env: environment("prepare"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => NOW,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue({ passed: true, receiptSha256: sha("boundary") }),
      readState,
      readPrivateEvidence: () => replacementReceipt(),
      reassertRepositoryState: () => true,
      writeDurable: (_directory, leaf, source) => {
        evidence.set(leaf, source);
        return sha(source);
      },
      writeOutput: (source) => output.push(source),
    });
    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(evidence.get("cold-prepare-terminal.json")!)).toMatchObject({
      outcome: "prepared_cold",
      replicasBefore: null,
      replicasAfter: null,
      replacementPrerequisite: {
        runId: REPLACEMENT_RUN,
        terminalSha256: sha(replacementReceipt()),
      },
      checks: { serviceRoleSealedBefore: true },
      normalOneToZeroReceiptClaimed: false,
    });
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ outcome: "prepared_cold" });
    const prepareSource = evidence.get("cold-prepare-terminal.json")!;
    expect(stagingWorkerBootstrapPrerequisiteInternals.validateColdPrepareReceipt(
      prepareSource,
      JSON.parse(prepareSource),
      CANDIDATE,
    )).toMatchObject({ outcome: "prepared_cold", replicasBefore: 1 });
  });

  it("rewrites an existing exact prepared-shape pair for the fresh candidate", async () => {
    const before = state(null, true);
    const after = state(null, true);
    const readState = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { variableCollectionUpsert: true },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const evidence = new Map<string, string>();
    const output: string[] = [];
    const code = await runProtectedPermanentStagingColdPrepare({
      argv: [
        "--candidate-sha", CANDIDATE,
        "--expected-deployment-sha", OLD_SOURCE,
        "--replacement-run-id", REPLACEMENT_RUN,
        "--replacement-terminal-file", "/private/terminal.json",
        "--evidence-dir", "/private/evidence",
      ],
      env: environment("prepare"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => NOW,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue({
        passed: true,
        receiptSha256: sha("boundary"),
      }),
      readState,
      readPrivateEvidence: () => replacementReceipt(),
      reassertRepositoryState: () => true,
      writeDurable: (_directory, leaf, source) => {
        evidence.set(leaf, source);
        return sha(source);
      },
      writeOutput: (source) => output.push(source),
    });

    expect(code).toBe(0);
    const mutation = JSON.parse(
      String((fetchImpl.mock.calls[2]![1] as RequestInit).body),
    ) as { variables: { variables: Record<string, string>; skipDeploys: boolean } };
    expect(mutation.variables).toEqual({
      projectId: COLD_RECOVERY_LOCK.projectId,
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      variables: {
        PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED: "false",
        PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: CANDIDATE,
      },
      skipDeploys: true,
    });
    expect(readState).toHaveBeenCalledTimes(3);
    expect(JSON.parse(evidence.get("cold-prepare-terminal.json")!)).toMatchObject({
      outcome: "prepared_cold",
      candidateSha: CANDIDATE,
      replicasBefore: null,
      replicasAfter: null,
      checks: {
        requiredVariablesBeforeExact: true,
        maintenanceRowsAfterExact: true,
        collateralVariablesUnchanged: true,
        deploymentAndTopologyUnchanged: true,
      },
    });
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ outcome: "prepared_cold" });
  });

  it("rejects an unsealed service-role row before a cold prepare write", async () => {
    const before = {
      ...state(null, false),
      rows: [row("PUBLIC_BASE_URL"), row("SUPABASE_SERVICE_ROLE_KEY", false)],
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope());
    const output: string[] = [];
    const code = await runProtectedPermanentStagingColdPrepare({
      argv: [
        "--candidate-sha", CANDIDATE,
        "--expected-deployment-sha", OLD_SOURCE,
        "--replacement-run-id", REPLACEMENT_RUN,
        "--replacement-terminal-file", "/private/terminal.json",
        "--evidence-dir", "/private/evidence",
      ],
      env: environment("prepare"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => NOW,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue({
        passed: true,
        receiptSha256: sha("boundary"),
      }),
      readState: vi.fn().mockResolvedValue(before),
      readPrivateEvidence: () => replacementReceipt(),
      reassertRepositoryState: () => true,
      writeDurable: vi.fn(),
      writeOutput: (source) => output.push(source),
    });
    expect(code).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      attempts: 0,
      checks: { serviceRoleSealedBefore: false },
    });
  });

  it("truthfully quiesces configured one to zero despite a null legacy aggregate", async () => {
    const before = state(null, true);
    const after = state(0, true);
    const readState = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope());
    const evidence = new Map<string, string>();
    const code = await runProtectedPermanentStagingColdQuiesce({
      argv: [
        "--candidate-sha", CANDIDATE,
        "--expected-deployment-sha", OLD_SOURCE,
        "--prepare-run-id", PREPARE_RUN,
        "--prepare-verification-file", "/private/prerequisites-verification.json",
        "--successor-bridge-file", "/private/cold-quiesce-successor-bridge.json",
        "--reviewed-authority-file", "/private/reviewed-authority.json",
        "--evidence-dir", "/private/evidence",
      ],
      env: environment("quiesce"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => NOW,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue({ passed: true, receiptSha256: sha("boundary") }),
      readState,
      readPrivateEvidence: (filename) =>
        filename.endsWith("cold-quiesce-successor-bridge.json")
          ? coldQuiesceSuccessorBridge()
          : filename.endsWith("reviewed-authority.json")
          ? coldQuiesceSuccessorAuthority()
          : coldPrepareVerification(),
      reassertRepositoryState: () => true,
      probeRuntimeAbsent: vi.fn().mockResolvedValue(true),
      commitScale: vi.fn().mockResolvedValue(
        directMutationAttempt("acknowledged"),
      ),
      writeDurable: (_directory, leaf, source) => {
        evidence.set(leaf, source);
        return sha(source);
      },
      writeOutput: vi.fn(),
    });
    expect(code).toBe(0);
    expect(JSON.parse(evidence.get("cold-quiesce-receipt.json")!)).toMatchObject({
      schemaVersion: "pintpath-permanent-staging-cold-quiesce/v5",
      outcome: "configured_zero",
      configuredReplicasBefore: 1,
      configuredReplicasAfter: 0,
      legacyReplicasBefore: null,
      legacyReplicasAfter: 0,
      configuredOneToZeroReceiptClaimed: true,
      successorBridge: { currentPrepareRunId: PREPARE_RUN },
      checks: {
        runtimeAbsentBefore: true,
        runtimeAbsentAfter: true,
        deploymentSourceAndTopologyUnchanged: true,
      },
    });
    const receiptSource = evidence.get("cold-quiesce-receipt.json")!;
    expect(stagingWorkerBootstrapPrerequisiteInternals.validateColdQuiesceReceipt(
      receiptSource,
      JSON.parse(receiptSource),
      CANDIDATE,
    )).toMatchObject({ outcome: "configured_zero", replicasAfter: 0 });
    const invalid = JSON.parse(receiptSource) as {
      checks: { exactZeroStateAfter: boolean };
    };
    invalid.checks.exactZeroStateAfter = false;
    expect(() => stagingWorkerBootstrapPrerequisiteInternals
      .validateColdQuiesceReceipt(canonical(invalid), invalid, CANDIDATE))
      .toThrow("receipt_invalid");
    const wrongPrepareBinding = JSON.parse(receiptSource) as {
      successorBridge: { currentPrepareRunId: string };
    };
    wrongPrepareBinding.successorBridge.currentPrepareRunId = "1001";
    expect(() => stagingWorkerBootstrapPrerequisiteInternals
      .validateColdQuiesceReceipt(
        canonical(wrongPrepareBinding),
        wrongPrepareBinding,
        CANDIDATE,
      )).toThrow("receipt_invalid");
  });

  it("binds the successor bridge and reviewed authority to the fresh prepare run", () => {
    const authoritySource = coldQuiesceSuccessorAuthority();
    const bridgeSource = coldQuiesceSuccessorBridge();
    expect(parseColdQuiesceSuccessorBinding(
      bridgeSource,
      authoritySource,
      CANDIDATE,
      CURRENT_RUN,
      PREPARE_RUN,
      NOW,
    )).toMatchObject({
      currentRunId: CURRENT_RUN,
      currentPrepareRunId: PREPARE_RUN,
    });

    const wrongBridge = JSON.parse(bridgeSource) as {
      currentPrepareRunId: string;
    };
    wrongBridge.currentPrepareRunId = "1001";
    expect(parseColdQuiesceSuccessorBinding(
      canonical(wrongBridge),
      authoritySource,
      CANDIDATE,
      CURRENT_RUN,
      PREPARE_RUN,
      NOW,
    )).toBeNull();

    const wrongProviderQuery = JSON.parse(bridgeSource) as {
      providerNoWriteProof: { querySha256: { history: string } };
    };
    wrongProviderQuery.providerNoWriteProof.querySha256.history = "0".repeat(64);
    expect(parseColdQuiesceSuccessorBinding(
      canonical(wrongProviderQuery),
      authoritySource,
      CANDIDATE,
      CURRENT_RUN,
      PREPARE_RUN,
      NOW,
    )).toBeNull();

    const missingFreeze = JSON.parse(bridgeSource) as {
      mutationExclusivity: { externalMutationFreezeAttestation: string };
    };
    missingFreeze.mutationExclusivity.externalMutationFreezeAttestation =
      "NOT_FROZEN";
    expect(parseColdQuiesceSuccessorBinding(
      canonical(missingFreeze),
      authoritySource,
      CANDIDATE,
      CURRENT_RUN,
      PREPARE_RUN,
      NOW,
    )).toBeNull();

    const wrongAuthority = JSON.parse(authoritySource) as {
      selectedColdPrepareRunId: string;
    };
    wrongAuthority.selectedColdPrepareRunId = "1001";
    const wrongAuthoritySource = `${JSON.stringify(wrongAuthority)}\n`;
    const bridgeForWrongAuthority = JSON.parse(bridgeSource) as {
      reviewedAuthoritySha256: string;
    };
    bridgeForWrongAuthority.reviewedAuthoritySha256 = sha(wrongAuthoritySource);
    expect(parseColdQuiesceSuccessorBinding(
      canonical(bridgeForWrongAuthority),
      wrongAuthoritySource,
      CANDIDATE,
      CURRENT_RUN,
      PREPARE_RUN,
      NOW,
    )).toBeNull();

    const mixedPriorAndLegacyAuthority = JSON.parse(authoritySource) as
      Record<string, unknown>;
    mixedPriorAndLegacyAuthority.priorFailedReadOnlyColdQuiesceReconcileRunId =
      COLD_QUIESCE_SUCCESSOR_BINDING.legacyReadOnlyReconcileRunId;
    const mixedAuthoritySource = `${JSON.stringify(mixedPriorAndLegacyAuthority)}\n`;
    const bridgeForMixedAuthority = JSON.parse(bridgeSource) as {
      reviewedAuthoritySha256: string;
    };
    bridgeForMixedAuthority.reviewedAuthoritySha256 = sha(mixedAuthoritySource);
    expect(parseColdQuiesceSuccessorBinding(
      canonical(bridgeForMixedAuthority),
      mixedAuthoritySource,
      CANDIDATE,
      CURRENT_RUN,
      PREPARE_RUN,
      NOW,
    )).toBeNull();

    for (const [field, replacement] of [
      ["priorColdPrepareRunId", "1001"],
      ["priorAmbiguousColdQuiesceTreeSha", "c".repeat(40)],
    ] as const) {
      const wrongLineageAuthority = JSON.parse(authoritySource) as
        Record<string, unknown>;
      wrongLineageAuthority[field] = replacement;
      const wrongLineageAuthoritySource =
        `${JSON.stringify(wrongLineageAuthority)}\n`;
      const bridgeForWrongLineage = JSON.parse(bridgeSource) as {
        reviewedAuthoritySha256: string;
      };
      bridgeForWrongLineage.reviewedAuthoritySha256 =
        sha(wrongLineageAuthoritySource);
      expect(parseColdQuiesceSuccessorBinding(
        canonical(bridgeForWrongLineage),
        wrongLineageAuthoritySource,
        CANDIDATE,
        CURRENT_RUN,
        PREPARE_RUN,
        NOW,
      )).toBeNull();
    }
  });

  it("accepts a lost scale acknowledgement only after exact configured-zero reconciliation", async () => {
    const before = state(null, true);
    const after = state(0, true);
    const evidence = new Map<string, string>();
    const code = await runProtectedPermanentStagingColdQuiesce({
      argv: [
        "--candidate-sha", CANDIDATE,
        "--expected-deployment-sha", OLD_SOURCE,
        "--prepare-run-id", PREPARE_RUN,
        "--prepare-verification-file", "/private/prerequisites-verification.json",
        "--successor-bridge-file", "/private/cold-quiesce-successor-bridge.json",
        "--reviewed-authority-file", "/private/reviewed-authority.json",
        "--evidence-dir", "/private/evidence",
      ],
      env: environment("quiesce"),
      cwd: process.cwd(),
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(scope())
        .mockResolvedValueOnce(scope()),
      now: () => NOW,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue({
        passed: true,
        receiptSha256: sha("boundary"),
      }),
      readState: vi.fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after),
      readPrivateEvidence: (filename) =>
        filename.endsWith("cold-quiesce-successor-bridge.json")
          ? coldQuiesceSuccessorBridge()
          : filename.endsWith("reviewed-authority.json")
          ? coldQuiesceSuccessorAuthority()
          : coldPrepareVerification(),
      reassertRepositoryState: () => true,
      probeRuntimeAbsent: vi.fn().mockResolvedValue(true),
      commitScale: vi.fn().mockResolvedValue(
        directMutationAttempt("transport_uncertain"),
      ),
      writeDurable: (_directory, leaf, source) => {
        evidence.set(leaf, source);
        return sha(source);
      },
      writeOutput: vi.fn(),
    });
    expect(code).toBe(0);
    expect(JSON.parse(evidence.get("cold-quiesce-receipt.json")!)).toMatchObject({
      outcome: "reconciled_configured_zero",
      failureCode: null,
      attempts: 1,
      checks: {
        acknowledgementExact: false,
        exactZeroStateAfter: true,
        collateralVariablesUnchanged: true,
      },
    });
    const receiptSource = evidence.get("cold-quiesce-receipt.json")!;
    expect(stagingWorkerBootstrapPrerequisiteInternals.validateColdQuiesceReceipt(
      receiptSource,
      JSON.parse(receiptSource),
      CANDIDATE,
    )).toMatchObject({ outcome: "reconciled_configured_zero", replicasAfter: 0 });
    const forgedAcknowledgedReconciliation = JSON.parse(receiptSource) as {
      directMutationEvidence: { transportOutcome: string };
    };
    forgedAcknowledgedReconciliation.directMutationEvidence.transportOutcome =
      "acknowledged";
    expect(() => stagingWorkerBootstrapPrerequisiteInternals
      .validateColdQuiesceReceipt(
        canonical(forgedAcknowledgedReconciliation),
        forgedAcknowledgedReconciliation,
        CANDIDATE,
      )).toThrow("receipt_invalid");
  });

  it("never reconciles a definitive provider rejection into success", async () => {
    const before = state(null, true);
    const after = state(0, true);
    const evidence = new Map<string, string>();
    const code = await runProtectedPermanentStagingColdQuiesce({
      argv: [
        "--candidate-sha", CANDIDATE,
        "--expected-deployment-sha", OLD_SOURCE,
        "--prepare-run-id", PREPARE_RUN,
        "--prepare-verification-file", "/private/prerequisites-verification.json",
        "--successor-bridge-file", "/private/cold-quiesce-successor-bridge.json",
        "--reviewed-authority-file", "/private/reviewed-authority.json",
        "--evidence-dir", "/private/evidence",
      ],
      env: environment("quiesce"),
      cwd: process.cwd(),
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(scope())
        .mockResolvedValueOnce(scope()),
      now: () => NOW,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue({
        passed: true,
        receiptSha256: sha("boundary"),
      }),
      readState: vi.fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after),
      readPrivateEvidence: (filename) =>
        filename.endsWith("cold-quiesce-successor-bridge.json")
          ? coldQuiesceSuccessorBridge()
          : filename.endsWith("reviewed-authority.json")
          ? coldQuiesceSuccessorAuthority()
          : coldPrepareVerification(),
      reassertRepositoryState: () => true,
      probeRuntimeAbsent: vi.fn().mockResolvedValue(true),
      commitScale: vi.fn().mockResolvedValue(
        directMutationAttempt("provider_rejected"),
      ),
      writeDurable: (_directory, leaf, source) => {
        evidence.set(leaf, source);
        return sha(source);
      },
      writeOutput: vi.fn(),
    });
    expect(code).toBe(1);
    const receiptSource = evidence.get("cold-quiesce-receipt.json")!;
    expect(JSON.parse(receiptSource)).toMatchObject({
      outcome: "mutation_uncertain",
      failureCode: "provider_rejected_without_acknowledgement",
      configuredOneToZeroReceiptClaimed: false,
      directMutationEvidence: {
        transportOutcome: "provider_rejected",
        acknowledgementExact: false,
      },
      checks: {
        mutationResponseClassified: true,
        acknowledgementExact: false,
        lostAcknowledgementExact: false,
        exactZeroStateAfter: true,
      },
    });
    expect(() => stagingWorkerBootstrapPrerequisiteInternals
      .validateColdQuiesceReceipt(
        receiptSource,
        JSON.parse(receiptSource),
        CANDIDATE,
      )).toThrow("receipt_invalid");
  });

  it("reconciles an abrupt cold-prepare runner loss read-only at exact null", async () => {
    const exactPrepared = state(null, true);
    const evidence = new Map<string, string>();
    const code = await runPermanentStagingColdPrepareReconciliationProbe({
      argv: [
        "--candidate-sha", CANDIDATE,
        "--expected-deployment-sha", OLD_SOURCE,
        "--replacement-run-id", REPLACEMENT_RUN,
        "--replacement-terminal-file", "/private/terminal.json",
        "--prior-prepare-run-id", "673",
        "--reviewed-authority-file", "/private/reviewed-authority.json",
        "--evidence-dir", "/private/evidence",
      ],
      env: reconcilePrepareEnvironment(),
      cwd: process.cwd(),
      fetchImpl: vi.fn().mockResolvedValueOnce(scope()),
      now: () => NOW,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue({
        passed: true,
        receiptSha256: sha("boundary"),
      }),
      readState: vi.fn().mockResolvedValue(exactPrepared),
      readPrivateEvidence: (filename) =>
        filename.endsWith("reviewed-authority.json")
          ? reconcilePrepareAuthority()
          : replacementReceipt(),
      reassertRepositoryState: () => true,
      probeRuntimeAbsent: vi.fn().mockResolvedValue(true),
      writeDurable: (_directory, leaf, source) => {
        evidence.set(leaf, source);
        return sha(source);
      },
      writeOutput: vi.fn(),
    });
    expect(code).toBe(0);
    const receiptSource = evidence.get("cold-prepare-terminal.json")!;
    expect(JSON.parse(receiptSource)).toMatchObject({
      schemaVersion:
        "pintpath-permanent-staging-cold-prepare-reconciliation/v2",
      operation: "cold-prepare",
      outcome: "reconciled_prepared_after_runner_loss",
      replicasBefore: null,
      replicasAfter: null,
      attempts: 0,
      runnerLossReconciliation: {
        priorAmbiguousPrepareRunId: "673",
        mutationCredentialPresent: false,
        providerWriteAttempted: false,
      },
      checks: {
        mutationCredentialsAbsent: true,
        noProviderWriteAttempted: true,
        exactPreparedDeadStateBefore: true,
        exactPreparedDeadStateAfter: true,
      },
      normalPrepareMutationReceiptClaimed: false,
    });
    expect(stagingWorkerBootstrapPrerequisiteInternals.validateColdPrepareReceipt(
      receiptSource,
      JSON.parse(receiptSource),
      CANDIDATE,
    )).toMatchObject({
      outcome: "reconciled_prepared_after_runner_loss",
      replicasBefore: 1,
      replicasAfter: 1,
    });
  });

  it.each([
    "PINTPATH_RAILWAY_STAGING_VARIABLE_TOKEN",
    "PINTPATH_RAILWAY_STAGING_VARIABLE_MUTATION_TOKEN",
  ] as const)("rejects cold-prepare reconciliation when %s remains", async (
    mutationCredential,
  ) => {
    const output: string[] = [];
    const code = await runPermanentStagingColdPrepareReconciliationProbe({
      argv: [
        "--candidate-sha", CANDIDATE,
        "--expected-deployment-sha", OLD_SOURCE,
        "--replacement-run-id", REPLACEMENT_RUN,
        "--replacement-terminal-file", "/private/terminal.json",
        "--prior-prepare-run-id", "673",
        "--reviewed-authority-file", "/private/reviewed-authority.json",
        "--evidence-dir", "/private/evidence",
      ],
      env: {
        ...reconcilePrepareEnvironment(),
        [mutationCredential]: "mutation-token-long-enough",
      },
      cwd: process.cwd(),
      fetchImpl: vi.fn(),
      now: () => NOW,
      sleep: vi.fn(),
      boundaryCheck: vi.fn(),
      readState: vi.fn(),
      readPrivateEvidence: (filename) =>
        filename.endsWith("reviewed-authority.json")
          ? reconcilePrepareAuthority()
          : replacementReceipt(),
      reassertRepositoryState: () => true,
      probeRuntimeAbsent: vi.fn(),
      writeDurable: vi.fn(),
      writeOutput: (source) => output.push(source),
    });
    expect(code).toBe(1);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      outcome: "probe_failed",
      attempts: 0,
      checks: { mutationCredentialsAbsent: false },
    });
  });

  it("reconciles an abrupt runner loss read-only from exact zero", async () => {
    const exactZero = state(0, true);
    const evidence = new Map<string, string>();
    const code = await runPermanentStagingColdQuiesceReconciliationProbe({
      argv: [
        "--candidate-sha", CANDIDATE,
        "--expected-deployment-sha", OLD_SOURCE,
        "--prepare-run-id", PREPARE_RUN,
        "--prepare-verification-file", "/private/prerequisites-verification.json",
        "--prior-quiesce-run-id", "676",
        "--reviewed-authority-file", "/private/reviewed-authority.json",
        "--successor-bridge-file", "/private/successor/cold-quiesce-successor-bridge.json",
        "--successor-reviewed-authority-file", "/private/successor/reviewed-authority.json",
        "--evidence-dir", "/private/evidence",
      ],
      env: reconcileEnvironment(),
      cwd: process.cwd(),
      fetchImpl: vi.fn().mockResolvedValueOnce(scope()),
      now: () => NOW,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue({
        passed: true,
        receiptSha256: sha("boundary"),
      }),
      readState: vi.fn().mockResolvedValue(exactZero),
      readPrivateEvidence: (filename) =>
        filename === "/private/reviewed-authority.json"
          ? reconcileAuthority()
          : filename.endsWith("cold-quiesce-successor-bridge.json")
          ? coldQuiesceSuccessorBridge("676")
          : filename === "/private/successor/reviewed-authority.json"
          ? coldQuiesceSuccessorAuthority("676")
          : coldPrepareVerification("cold-reconcile-quiesce"),
      reassertRepositoryState: () => true,
      probeRuntimeAbsent: vi.fn().mockResolvedValue(true),
      writeDurable: (_directory, leaf, source) => {
        evidence.set(leaf, source);
        return sha(source);
      },
      writeOutput: vi.fn(),
    });
    expect(code).toBe(0);
    const receiptSource = evidence.get("cold-quiesce-receipt.json")!;
    expect(JSON.parse(receiptSource)).toMatchObject({
      schemaVersion: "pintpath-permanent-staging-cold-quiesce/v5",
      operation: "cold-quiesce",
      outcome: "reconciled_configured_zero_after_runner_loss",
      configuredReplicasBefore: 0,
      configuredReplicasAfter: 0,
      attempts: 0,
      runnerLossReconciliation: {
        priorAmbiguousQuiesceRunId: "676",
        scaleCredentialPresent: false,
        providerWriteAttempted: false,
      },
      directMutationEvidence: {
        operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
        operation: "environmentPatchCommit",
        transportOutcome: "not_attempted",
        variablesSha256: null,
        requestBodySha256: null,
        responseBodySha256: null,
        acknowledgementSha256: null,
        acknowledgementExact: false,
        commitMessageSha256: null,
        zeroRegionsEncodedAsJsonNull: false,
      },
      checks: {
        scaleCredentialAbsent: true,
        noProviderWriteAttempted: true,
        exactZeroStateBefore: true,
        exactZeroStateAfter: true,
      },
    });
    expect(stagingWorkerBootstrapPrerequisiteInternals.validateColdQuiesceReceipt(
      receiptSource,
      JSON.parse(receiptSource),
      CANDIDATE,
    )).toMatchObject({
      outcome: "reconciled_configured_zero_after_runner_loss",
      replicasBefore: 0,
      replicasAfter: 0,
    });
    const observedSpec = stagingWorkerBootstrapPrerequisiteInternals
      .producerSpecForObservedRun("cold-quiesce", CANDIDATE, {
        display_title:
          `Permanent staging cold recovery | reconcile-quiesce | ${CANDIDATE}`,
      });
    expect(observedSpec.title(CANDIDATE)).toBe(
      `Permanent staging cold recovery | reconcile-quiesce | ${CANDIDATE}`,
    );
    const verificationSource = coldPrepareVerification(
      "cold-reconcile-quiesce",
    );
    expect(stagingWorkerBootstrapPrerequisiteInternals.validatePriorVerification(
      verificationSource,
      JSON.parse(verificationSource),
      {
        operation: "cold-quiesce",
        bootstrapPath: "cold-dead",
        candidateSha: CANDIDATE,
        runId: CURRENT_RUN,
      },
    )).toMatchObject({ expectedDeploymentSha: OLD_SOURCE });
    const forgedWritableReceipt = JSON.parse(receiptSource) as {
      runnerLossReconciliation: { scaleCredentialPresent: boolean };
    };
    forgedWritableReceipt.runnerLossReconciliation.scaleCredentialPresent = true;
    expect(() => stagingWorkerBootstrapPrerequisiteInternals
      .validateColdQuiesceReceipt(
        canonical(forgedWritableReceipt),
        forgedWritableReceipt,
        CANDIDATE,
      )).toThrow("receipt_invalid");
  });

  it("rejects substituted successor authority bytes before reconcile provider access", async () => {
    const fetchImpl = vi.fn();
    const readState = vi.fn();
    const output: string[] = [];
    const code = await runPermanentStagingColdQuiesceReconciliationProbe({
      argv: [
        "--candidate-sha", CANDIDATE,
        "--expected-deployment-sha", OLD_SOURCE,
        "--prepare-run-id", PREPARE_RUN,
        "--prepare-verification-file", "/private/prerequisites-verification.json",
        "--prior-quiesce-run-id", "676",
        "--reviewed-authority-file", "/private/reviewed-authority.json",
        "--successor-bridge-file", "/private/successor/cold-quiesce-successor-bridge.json",
        "--successor-reviewed-authority-file", "/private/successor/reviewed-authority.json",
        "--evidence-dir", "/private/evidence",
      ],
      env: reconcileEnvironment(),
      cwd: process.cwd(),
      fetchImpl,
      now: () => NOW,
      sleep: vi.fn(),
      boundaryCheck: vi.fn(),
      readState,
      readPrivateEvidence: (filename) =>
        filename === "/private/reviewed-authority.json"
          ? reconcileAuthority()
          : filename.endsWith("cold-quiesce-successor-bridge.json")
          ? coldQuiesceSuccessorBridge("676")
          : filename === "/private/successor/reviewed-authority.json"
          ? `${coldQuiesceSuccessorAuthority("676")}\n`
          : coldPrepareVerification("cold-reconcile-quiesce"),
      reassertRepositoryState: vi.fn(),
      probeRuntimeAbsent: vi.fn(),
      writeDurable: vi.fn(),
      writeOutput: (source) => output.push(source),
    });
    expect(code).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readState).not.toHaveBeenCalled();
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      outcome: "probe_failed",
      failureCode: "successor_bridge_invalid",
      attempts: 0,
      checks: { successorBridgeExact: false },
    });
  });

  it("rejects read-only reconciliation when a scale credential or nonzero state exists", async () => {
    for (const [env, observed] of [
      [{
        ...reconcileEnvironment(),
        PINTPATH_RAILWAY_STAGING_SCALE_TOKEN: "scale-token-long-enough",
      }, state(0, true)],
      [reconcileEnvironment(), state(null, true)],
    ] as const) {
      const output: string[] = [];
      const code = await runPermanentStagingColdQuiesceReconciliationProbe({
        argv: [
          "--candidate-sha", CANDIDATE,
          "--expected-deployment-sha", OLD_SOURCE,
          "--prepare-run-id", PREPARE_RUN,
          "--prepare-verification-file", "/private/prerequisites-verification.json",
          "--prior-quiesce-run-id", "676",
          "--reviewed-authority-file", "/private/reviewed-authority.json",
          "--successor-bridge-file", "/private/successor/cold-quiesce-successor-bridge.json",
          "--successor-reviewed-authority-file", "/private/successor/reviewed-authority.json",
          "--evidence-dir", "/private/evidence",
        ],
        env,
        cwd: process.cwd(),
        fetchImpl: vi.fn().mockResolvedValue(scope()),
        now: () => NOW,
        sleep: vi.fn(),
        boundaryCheck: vi.fn().mockResolvedValue({
          passed: true,
          receiptSha256: sha("boundary"),
        }),
        readState: vi.fn().mockResolvedValue(observed),
        readPrivateEvidence: (filename) =>
          filename === "/private/reviewed-authority.json"
            ? reconcileAuthority()
            : filename.endsWith("cold-quiesce-successor-bridge.json")
            ? coldQuiesceSuccessorBridge("676")
            : filename === "/private/successor/reviewed-authority.json"
            ? coldQuiesceSuccessorAuthority("676")
            : coldPrepareVerification("cold-reconcile-quiesce"),
        reassertRepositoryState: () => true,
        probeRuntimeAbsent: vi.fn().mockResolvedValue(true),
        writeDurable: vi.fn(),
        writeOutput: (source) => output.push(source),
      });
      expect(code).toBe(1);
      expect(JSON.parse(output.at(-1)!)).toMatchObject({
        outcome: "probe_failed",
        attempts: 0,
      });
    }
  });
});
