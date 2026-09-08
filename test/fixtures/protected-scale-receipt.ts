import crypto from "node:crypto";

import {
  railwayEnvironmentPatchCommitVariables,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
} from "../../scripts/lib/railway-environment-patch-commit.js";
import {
  PROTECTED_PRODUCTION_SCALE_PATCH_HISTORY_QUERY,
  PROTECTED_PRODUCTION_SCALE_PATCH_QUERY,
} from "../../scripts/lib/protected-production-scale-receipt.js";

const PRIMARY_REGION = "asia-southeast1-eqsg3a";
const LEGACY_STAGING_REGION = "europe-west4-drams3a";

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort().map((key) => [
      key,
      sortObjectKeys((value as Record<string, unknown>)[key]),
    ]));
}

function canonicalProviderJson(value: unknown): string {
  return `${JSON.stringify(sortObjectKeys(value), null, 2)}\n`;
}

function snapshot(
  regions: readonly { readonly region: string; readonly numReplicas: number }[],
  legacyAggregateReplicas: number | null,
) {
  const configuredRegions = [...regions]
    .sort((left, right) => left.region < right.region ? -1
      : left.region > right.region ? 1 : 0)
    .map(({ region, numReplicas }) => ({ region, numReplicas }));
  const configuredReplicas = configuredRegions.reduce(
    (total, entry) => total + entry.numReplicas,
    0,
  );
  const configured = { configuredReplicas, configuredRegions };
  return {
    ...configured,
    configuredTopologySha256: sha256(canonical(configured)),
    legacyAggregateReplicas,
  };
}

function scaleSnapshot(
  regions: readonly { readonly region: string; readonly numReplicas: number }[],
  legacyAggregateReplicas: number | null,
) {
  return {
    ...snapshot(regions, legacyAggregateReplicas),
    serviceSourceSha256: "f".repeat(64),
    stagedPatchEmpty: true,
  };
}

export function productionScaleTopologyFixture(
  options: {
    readonly attempts?: 0 | 1;
    readonly legacyBefore?: number | null;
    readonly legacyImmediatelyBeforeWrite?: number | null;
    readonly legacyAfter?: number | null;
  } = {},
) {
  const attempts = options.attempts ?? 1;
  const beforeReplicas = attempts === 0 ? 2 : 1;
  const before = scaleSnapshot(
    [{ region: PRIMARY_REGION, numReplicas: beforeReplicas }],
    options.legacyBefore ?? null,
  );
  return {
    authoritySource: "environment.config(decryptVariables:false)",
    primaryRegion: PRIMARY_REGION,
    allowedRegions: [PRIMARY_REGION],
    before,
    immediatelyBeforeWrite: attempts === 0
      ? null
      : scaleSnapshot(
          [{ region: PRIMARY_REGION, numReplicas: 1 }],
          options.legacyImmediatelyBeforeWrite ?? 47,
        ),
    after: scaleSnapshot(
      [{ region: PRIMARY_REGION, numReplicas: 2 }],
      options.legacyAfter ?? null,
    ),
    patchRegions: attempts === 0
      ? []
      : [{ region: PRIMARY_REGION, numReplicas: 2 }],
    environmentConfigCollateralUnchanged: true,
  };
}

export function productionScaleReceiptFixture(options: {
  readonly candidateSha: string;
  readonly githubRunId: string;
  readonly deploymentBeforeActivationIdSha256: string;
  readonly deploymentIdSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly activationRunId?: string;
  readonly outcome?: "scaled" | "reconciled_scaled" | "already_converged";
}) {
  const outcome = options.outcome ?? "scaled";
  const attempts = outcome === "already_converged" ? 0 : 1;
  const commitMessage =
    `PintPath scale converge-production-two ${options.candidateSha} run ${options.githubRunId}`;
  const variables = railwayEnvironmentPatchCommitVariables({
    environmentId: "13dab015-df74-45c6-b26f-69323daea99a",
    serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
    regions: [{ region: PRIMARY_REGION, numReplicas: 2 }],
    commitMessage,
  })!;
  const requestBody = JSON.stringify({
    operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
    query: RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
    variables,
  });
  const commonProjectionSha256 = "8".repeat(64);
  const attempted = attempts === 1;
  const acknowledged = outcome === "scaled";
  const lostAcknowledgement = outcome === "reconciled_scaled";
  return {
    schemaVersion: "pintpath-permanent-staging-scale-operation/v4",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    direction: "converge-production-two",
    outcome,
    candidateSha: options.candidateSha,
    githubRunId: options.githubRunId,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    desiredReplicas: 2,
    deploymentIdSha256: options.deploymentIdSha256,
    attempts,
    retryAllowed: false,
    intentSha256: attempted ? "1".repeat(64) : null,
    terminalEvidenceSha256: "2".repeat(64),
    directMutationEvidence: {
      operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
      operation: "environmentPatchCommit",
      transportOutcome: acknowledged ? "acknowledged"
        : lostAcknowledgement ? "transport_uncertain" : null,
      querySha256: sha256(RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION),
      variablesSha256: attempted ? sha256(JSON.stringify(variables)) : null,
      requestBodySha256: attempted ? sha256(requestBody) : null,
      responseBodySha256: acknowledged ? "3".repeat(64) : null,
      acknowledgementSha256: acknowledged ? "4".repeat(64) : null,
      acknowledgementExact: acknowledged,
      commitMessageSha256: attempted ? sha256(commitMessage) : null,
      zeroRegionsEncodedAsJsonNull: attempted,
      providerCasOrLockVerified: false,
      externalMutationFreezeEnforcement: "operational_attestation_only",
    },
    providerHistoryEvidence: attempted ? {
      prewrite: {
        querySha256: {
          history: sha256(PROTECTED_PRODUCTION_SCALE_PATCH_HISTORY_QUERY),
          patch: sha256(PROTECTED_PRODUCTION_SCALE_PATCH_QUERY),
        },
        pages: [{
          requestAfter: null,
          count: 1,
          endCursor: "prewrite-cursor",
          hasNextPage: false,
        }],
        pageCount: 1,
        rowCount: 1,
        rowsProjectionSha256: commonProjectionSha256,
        nonMatchingRowsProjectionSha256: commonProjectionSha256,
        paginationCompleteExact: true,
        matchingPatchCount: 0,
        matchingPatch: null,
        secretMaterialIncluded: false,
        secretDerivedCommitmentsIncluded: false,
      },
      postflight: {
        querySha256: {
          history: sha256(PROTECTED_PRODUCTION_SCALE_PATCH_HISTORY_QUERY),
          patch: sha256(PROTECTED_PRODUCTION_SCALE_PATCH_QUERY),
        },
        pages: [{
          requestAfter: null,
          count: 2,
          endCursor: "postflight-cursor",
          hasNextPage: false,
        }],
        pageCount: 1,
        rowCount: 2,
        rowsProjectionSha256: "9".repeat(64),
        nonMatchingRowsProjectionSha256: commonProjectionSha256,
        paginationCompleteExact: true,
        matchingPatchCount: 1,
        matchingPatch: {
          rowIndex: 0,
          idSha256: "5".repeat(64),
          status: "COMMITTED",
          createdAt: options.startedAt,
          updatedAt: options.startedAt,
          appliedAt: options.startedAt,
          messageSha256: sha256(commitMessage),
          patchSha256: sha256(canonicalProviderJson(variables.patch)),
          crossFetchExact: true,
        },
        secretMaterialIncluded: false,
        secretDerivedCommitmentsIncluded: false,
      },
    } : { prewrite: null, postflight: null },
    productionActivationPrerequisite: {
      runId: options.activationRunId ?? "8000",
      verificationSha256: "5".repeat(64),
      terminalSha256: "6".repeat(64),
      prerequisitesSha256: "7".repeat(64),
      deploymentBeforeIdSha256: options.deploymentBeforeActivationIdSha256,
      deploymentAfterIdSha256: options.deploymentIdSha256,
    },
    replicaTopology: productionScaleTopologyFixture({ attempts }),
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
    checks: {
      policyExact: true,
      githubAuthorityExact: true,
      externalMutationFreezeAttested: true,
      tokenScopesExact: true,
      directMutationContractExact: true,
      boundaryPreflightExact: true,
      targetPreflightExact: true,
      productionActivationPrerequisiteExact: true,
      productionActivationDeploymentContinuityExact: true,
      runtimePreflightExact: true,
      durableIntentExact: attempted,
      repositoryPrewriteReasserted: true,
      writeAttemptedAtMostOnce: true,
      mutationResponseClassified: attempted,
      acknowledgementExact: acknowledged,
      lostAcknowledgementExact: lostAcknowledgement,
      providerHistoryPrewriteExact: attempted,
      providerHistoryPostflightExact: attempted,
      postflightAttempted: true,
      targetPostflightExact: true,
      runtimePostflightExact: true,
      candidateUnchanged: true,
      deploymentUnchanged: true,
      providerConfigurationCollateralUnchanged: true,
      replicaTopologyEvidenceExact: true,
      boundaryPostflightExact: true,
      terminalEvidenceExact: true,
      finalReceiptEvidenceExact: true,
    },
  };
}

export function stagingScaleReceiptFixture(options: {
  readonly direction: "quiesce-staging-zero" | "bootstrap-staging-one";
  readonly candidateSha: string;
  readonly githubRunId: string;
  readonly deploymentIdSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome?: "scaled" | "reconciled_scaled";
}) {
  const outcome = options.outcome ?? "scaled";
  const desiredReplicas = options.direction === "quiesce-staging-zero" ? 0 : 1;
  const commitMessage =
    `PintPath scale ${options.direction} ${options.candidateSha} run ${options.githubRunId}`;
  const variables = railwayEnvironmentPatchCommitVariables({
    environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
    regions: [
      { region: PRIMARY_REGION, numReplicas: desiredReplicas },
      { region: LEGACY_STAGING_REGION, numReplicas: 0 },
    ],
    commitMessage,
  })!;
  const requestBody = JSON.stringify({
    operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
    query: RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
    variables,
  });
  const acknowledged = outcome === "scaled";
  const commonProjectionSha256 = "8".repeat(64);
  return {
    schemaVersion: "pintpath-permanent-staging-scale-operation/v4",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    direction: options.direction,
    outcome,
    candidateSha: options.candidateSha,
    githubRunId: options.githubRunId,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    desiredReplicas,
    deploymentIdSha256: options.deploymentIdSha256,
    attempts: 1,
    retryAllowed: false,
    intentSha256: "1".repeat(64),
    terminalEvidenceSha256: "2".repeat(64),
    directMutationEvidence: {
      operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
      operation: "environmentPatchCommit",
      transportOutcome: acknowledged ? "acknowledged" : "transport_uncertain",
      querySha256: sha256(RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION),
      variablesSha256: sha256(JSON.stringify(variables)),
      requestBodySha256: sha256(requestBody),
      responseBodySha256: acknowledged ? "3".repeat(64) : null,
      acknowledgementSha256: acknowledged ? "4".repeat(64) : null,
      acknowledgementExact: acknowledged,
      commitMessageSha256: sha256(commitMessage),
      zeroRegionsEncodedAsJsonNull: true,
      providerCasOrLockVerified: false,
      externalMutationFreezeEnforcement: "operational_attestation_only",
    },
    providerHistoryEvidence: {
      prewrite: {
        querySha256: {
          history: sha256(PROTECTED_PRODUCTION_SCALE_PATCH_HISTORY_QUERY),
          patch: sha256(PROTECTED_PRODUCTION_SCALE_PATCH_QUERY),
        },
        pages: [{
          requestAfter: null,
          count: 1,
          endCursor: "prewrite-cursor",
          hasNextPage: false,
        }],
        pageCount: 1,
        rowCount: 1,
        rowsProjectionSha256: commonProjectionSha256,
        nonMatchingRowsProjectionSha256: commonProjectionSha256,
        paginationCompleteExact: true,
        matchingPatchCount: 0,
        matchingPatch: null,
        secretMaterialIncluded: false,
        secretDerivedCommitmentsIncluded: false,
      },
      postflight: {
        querySha256: {
          history: sha256(PROTECTED_PRODUCTION_SCALE_PATCH_HISTORY_QUERY),
          patch: sha256(PROTECTED_PRODUCTION_SCALE_PATCH_QUERY),
        },
        pages: [{
          requestAfter: null,
          count: 2,
          endCursor: "postflight-cursor",
          hasNextPage: false,
        }],
        pageCount: 1,
        rowCount: 2,
        rowsProjectionSha256: "9".repeat(64),
        nonMatchingRowsProjectionSha256: commonProjectionSha256,
        paginationCompleteExact: true,
        matchingPatchCount: 1,
        matchingPatch: {
          rowIndex: 0,
          idSha256: "5".repeat(64),
          status: "COMMITTED",
          createdAt: options.startedAt,
          updatedAt: options.startedAt,
          appliedAt: options.startedAt,
          messageSha256: sha256(commitMessage),
          patchSha256: sha256(canonicalProviderJson(variables.patch)),
          crossFetchExact: true,
        },
        secretMaterialIncluded: false,
        secretDerivedCommitmentsIncluded: false,
      },
    },
    productionActivationPrerequisite: null,
    replicaTopology: options.direction === "quiesce-staging-zero"
      ? stagingQuiesceScaleTopologyFixture()
      : stagingRestoreScaleTopologyFixture(),
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
    checks: {
      policyExact: true,
      githubAuthorityExact: true,
      externalMutationFreezeAttested: true,
      tokenScopesExact: true,
      directMutationContractExact: true,
      boundaryPreflightExact: true,
      targetPreflightExact: true,
      productionActivationPrerequisiteExact: true,
      productionActivationDeploymentContinuityExact: true,
      runtimePreflightExact: true,
      durableIntentExact: true,
      repositoryPrewriteReasserted: true,
      writeAttemptedAtMostOnce: true,
      mutationResponseClassified: true,
      acknowledgementExact: acknowledged,
      lostAcknowledgementExact: !acknowledged,
      providerHistoryPrewriteExact: true,
      providerHistoryPostflightExact: true,
      postflightAttempted: true,
      targetPostflightExact: true,
      runtimePostflightExact: true,
      candidateUnchanged: true,
      deploymentUnchanged: true,
      providerConfigurationCollateralUnchanged: true,
      replicaTopologyEvidenceExact: true,
      boundaryPostflightExact: true,
      terminalEvidenceExact: true,
      finalReceiptEvidenceExact: true,
    },
  };
}

export function productionRouteTopologyFixture(
  options: {
    readonly legacyBefore?: number | null;
    readonly legacyImmediatelyBeforeWrite?: number | null;
    readonly legacyAfter?: number | null;
  } = {},
) {
  const before = snapshot(
    [{ region: PRIMARY_REGION, numReplicas: 2 }],
    options.legacyBefore ?? null,
  );
  return {
    authoritySource: "environment.config(decryptVariables:false)",
    primaryRegion: PRIMARY_REGION,
    allowedRegions: [PRIMARY_REGION],
    before,
    immediatelyBeforeWrite: snapshot(
      [{ region: PRIMARY_REGION, numReplicas: 2 }],
      options.legacyImmediatelyBeforeWrite ?? null,
    ),
    after: snapshot(
      [{ region: PRIMARY_REGION, numReplicas: 2 }],
      options.legacyAfter ?? null,
    ),
  };
}

export function stagingQuiesceScaleTopologyFixture() {
  const beforeRegions = [{ region: LEGACY_STAGING_REGION, numReplicas: 1 }];
  return {
    authoritySource: "environment.config(decryptVariables:false)",
    primaryRegion: PRIMARY_REGION,
    allowedRegions: [PRIMARY_REGION, LEGACY_STAGING_REGION],
    before: scaleSnapshot(beforeRegions, null),
    immediatelyBeforeWrite: scaleSnapshot(beforeRegions, 1),
    after: scaleSnapshot([
      { region: PRIMARY_REGION, numReplicas: 0 },
      { region: LEGACY_STAGING_REGION, numReplicas: 0 },
    ], null),
    patchRegions: [
      { region: PRIMARY_REGION, numReplicas: 0 },
      { region: LEGACY_STAGING_REGION, numReplicas: 0 },
    ],
    environmentConfigCollateralUnchanged: true,
  };
}

export function stagingRestoreScaleTopologyFixture() {
  const beforeRegions = [
    { region: PRIMARY_REGION, numReplicas: 0 },
    { region: LEGACY_STAGING_REGION, numReplicas: 0 },
  ];
  return {
    authoritySource: "environment.config(decryptVariables:false)",
    primaryRegion: PRIMARY_REGION,
    allowedRegions: [PRIMARY_REGION, LEGACY_STAGING_REGION],
    before: scaleSnapshot(beforeRegions, null),
    immediatelyBeforeWrite: scaleSnapshot(beforeRegions, 29),
    after: scaleSnapshot([
      { region: PRIMARY_REGION, numReplicas: 1 },
      { region: LEGACY_STAGING_REGION, numReplicas: 0 },
    ], null),
    patchRegions: [
      { region: PRIMARY_REGION, numReplicas: 1 },
      { region: LEGACY_STAGING_REGION, numReplicas: 0 },
    ],
    environmentConfigCollateralUnchanged: true,
  };
}
