import crypto from "node:crypto";

import {
  coldRecoveryRowsExact,
  nonMaintenanceRows,
  type ColdRecoveryVariableRow,
} from "./permanent-staging-cold-recovery.js";
import { parseRailwayMultiRegionReplicaTopology } from
  "./railway-multi-region-replica-topology.js";

export const POST_Q_DEPLOYMENT_STOP_OPERATION =
  "permanent-staging-post-q-deployment-stop" as const;
export const POST_Q_DEPLOYMENT_STOP_INTENT_SCHEMA =
  "pintpath-permanent-staging-post-q-deployment-stop-intent/v1" as const;
export const POST_Q_DEPLOYMENT_STOP_TERMINAL_SCHEMA =
  "pintpath-permanent-staging-post-q-deployment-stop-terminal/v1" as const;
export const POST_Q_DEPLOYMENT_STOP_APPLY_TERMINAL_SCHEMA =
  "pintpath-permanent-staging-post-q-deployment-stop-apply-terminal/v1" as const;
export const POST_Q_DEPLOYMENT_STOP_EXECUTOR_SCHEMA =
  "pintpath-permanent-staging-post-q-deployment-stop-executor/v1" as const;
export const POST_Q_DEPLOYMENT_STOP_STATE_PROJECTION_SCHEMA =
  "pintpath-permanent-staging-post-q-state-projection/v1" as const;

export const POST_Q_DEPLOYMENT_STOP_LOCK = Object.freeze({
  repository: "blackmagic30/Beer",
  ref: "refs/heads/main",
  projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  forbiddenProductionEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
  serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
  serviceInstanceId: "5a2f3970-2850-44e0-9b6c-f5c7627dde13",
  deploymentId: "6300a324-9407-4b1c-b651-749c47e9537f",
  snapshotId: "92c2253a-60c4-47fb-8053-a2aee33fc944",
  sourceSha: "12c0d24f6619a0286e16b8daf56fc27aaa1e3aba",
  imageDigest:
    "sha256:35787ff955a6f2f729ebe7e2220a6146d9429d2ab37e2a88b86225ff0681816e",
  deploymentPatchId: null,
  qPatchId: "c6fe9c8a-b26e-4a1d-9d46-4b6ea7d84ad1",
  domainId: "afbb2417-c6df-48e3-9987-271b10ab2962",
  domain: "beer-staging.up.railway.app",
  publicOrigin: "https://beer-staging.up.railway.app",
  targetPort: 8_080,
  configuredRegion: "us-west2",
  baseline: Object.freeze({
    stateSha256:
      "c5301d50929dd463a45868b5e7c4db869eec9b95113f609b4631fc24ba629425",
    stoppedStateSha256:
      "133afe93ed56697ea4ea621e5c07112833084c8994ac9073fce919dc89f5717b",
    environmentConfigSha256:
      "8ab34441af1ec87d5068ce0155975a9fea46a192537b70c54677e64f60ae183e",
    stagedPatchSha256:
      "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
    sourceIdentitySha256:
      "d4fd7186aeed76717f612e2671cd6ec5bc20086d819a6644ad73e4934baea205",
    topologySha256:
      "63b2f7cf3dd9f12b05ab9f695555764d5908d3048cdc98be3938499daa079ea9",
    variableInventorySha256:
      "2164ff3f0b321e8de557e91394fc96dced4100d84405f1c32174a567ade9fc15",
    collateralVariablesSha256:
      "76aeec3ee15ddb7c6f628d841815ab1a86d2e04b7685b9ec2ce165bcb500bf7f",
    offTargetVariablesSha256:
      "2e09efb56d0101fd30c7d1d217e52e51f1b75efefa5342b5472b28ddedc476e7",
    variableRows: 97,
    targetVariableRows: 76,
    offTargetVariableRows: 21,
    nullServiceVariableRows: 0,
    historyCount: 14,
    historyRowsSha256:
      "c148abfa11eda85933b6f80ec3a682bd58afe8cf03ca17c8c55b72d6fdda7296",
    qHistoryRowsSha256:
      "b03b5f774b5e76100251bb32f4d22118ee1869961e01e2c65ffb39b7fd975374",
    patchCount: 127,
    patchRowsSha256:
      "8625b57c0a91e83447b3194992642a129c9d55470e203cc41fddff67a2680bbf",
    qPatchProjectionSha256:
      "20a9837d61c6c192da021fa07d453c29691b248537d6617c9ba2f9985aa4e8ce",
  }),
  q: Object.freeze({
    candidateSha: "606d33facb515dd10bc94c360e43c20beb999cc1",
    runId: "34229745722",
    runAttempt: 1,
    artifactId: "10057495901",
    artifactName:
      "pintpath-permanent-staging-cold-quiesce-606d33facb515dd10bc94c360e43c20beb999cc1",
    artifactDigest:
      "sha256:32a404cdd7078dc04d4b2531deec460dd4f44b4309fe35d873c8bcd46a367c4b",
    receiptSha256:
      "f1ee14e3d8082add77cefeaafde38f188df36e29688cba679cbc92b75bb322c5",
    intentSha256:
      "2937fa93e50fd01ed36f7578e6da3d236eec73d1efc65f120aa02581d7b81d99",
    prerequisiteSha256:
      "fe423786cb2db2af8230fc8e3fb7bb6a19a9cbe366adb1a6542aade79c8f7867",
    successorBridgeSha256:
      "b355f3474a368e4f4b97c98d6d5fc1f35b01e0aa48d22f1c19e6a1d8ccadaec3",
    reviewedAuthoritySha256:
      "877d697225c6f8a6290386a1f2e9b003ee1a521b01af0cd046d482a4b16c8dfc",
    patchId: "c6fe9c8a-b26e-4a1d-9d46-4b6ea7d84ad1",
  }),
  recoveryBridge: Object.freeze({
    candidateSha: "f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7",
    treeSha: "9978dca9491f7bf7bee77ce39debe1f713e89c53",
    soleParentSha: "606d33facb515dd10bc94c360e43c20beb999cc1",
    runId: "34255228036",
    runAttempt: 1,
    workflowId: 353312302,
    prepareJobId: "102159216963",
    applyJobId: "102160681336",
  }),
  stableObservationCount: 3,
  stableObservationIntervalMs: 10_000,
  minimumStableObservationSpanMs: 20_000,
  maximumPollRounds: 28,
  maximumObservationSpanMs: 300_000,
} as const);

export const POST_Q_DEPLOYMENT_STOP_SCOPE_QUERY =
  `query PintPathPostQDeploymentStopScope { projectToken { projectId environmentId } }`;
export const POST_Q_DEPLOYMENT_STOP_STATE_QUERY =
  `query PintPathPostQDeploymentStopState(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
  $deploymentId: String!
) {
  environment(id:$environmentId,projectId:$projectId) {
    id
    config(decryptVariables:false)
    variables(first:100) {
      edges { node { id name environmentId serviceId isSealed references } }
      pageInfo { hasNextPage endCursor }
    }
  }
  staged: environmentStagedChanges(environmentId:$environmentId) {
    environmentId
    patch(decryptVariables:false)
  }
  serviceInstance(environmentId:$environmentId,serviceId:$serviceId) {
    id serviceId environmentId numReplicas
    source { repo image }
    latestDeployment { id status deploymentStopped snapshotId }
    activeDeployments { id status deploymentStopped }
    domains {
      serviceDomains { id domain targetPort }
      customDomains { id domain targetPort }
    }
  }
  deployment(id:$deploymentId) {
    id projectId environmentId serviceId snapshotId meta
  }
}` as const;
export const POST_Q_DEPLOYMENT_STOP_HISTORY_QUERY =
  `query PintPathPostQDeploymentStopHistory(
  $environmentId:String!
  $serviceId:String!
  $after:String
) {
  environmentHistory(
    environmentId:$environmentId
    first:100
    after:$after
    filter:{serviceIds:[$serviceId]}
  ) {
    edges { cursor node {
      id createdAt object action outcome operationKind severity source workflowId activityPayload
    } }
    pageInfo { hasNextPage endCursor }
  }
}` as const;
export const POST_Q_DEPLOYMENT_STOP_PATCHES_QUERY =
  `query PintPathPostQDeploymentStopPatches($environmentId:String!,$after:String) {
  environmentPatches(environmentId:$environmentId,first:100,after:$after) {
    edges { cursor node {
      id environmentId status createdAt updatedAt appliedAt message patch(decryptVariables:false)
    } }
    pageInfo { hasNextPage endCursor }
  }
}` as const;
export const POST_Q_DEPLOYMENT_STOP_MUTATION =
  `mutation PintPathPostQDeploymentStop($deploymentId:String!) {
  deploymentStop(id:$deploymentId)
}` as const;

export const POST_Q_DEPLOYMENT_STOP_VARIABLES = Object.freeze({
  deploymentId: POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId,
});

/** The sole byte representation authorized for the deploymentStop request. */
export function buildPostQDeploymentStopRequestBody(): string {
  return JSON.stringify({
    query: POST_Q_DEPLOYMENT_STOP_MUTATION,
    variables: POST_Q_DEPLOYMENT_STOP_VARIABLES,
  });
}

const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[^\r\n\0\s]{16,4096}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Json = Record<string, unknown>;

export interface DeploymentSummary {
  readonly id: string;
  readonly status: string;
  readonly deploymentStopped: boolean;
}

export interface PostQDeploymentStopSnapshot {
  readonly environmentId: string;
  readonly serviceInstanceId: string;
  readonly serviceId: string;
  readonly numReplicas: number | null;
  readonly configuredReplicas: number;
  readonly configuredRegions: readonly { readonly region: string; readonly numReplicas: number }[];
  readonly deploymentRegions: readonly { readonly region: string; readonly numReplicas: number }[];
  readonly source: { readonly repo: string | null; readonly image: string | null };
  readonly latestDeployment: DeploymentSummary & { readonly snapshotId: string };
  readonly activeDeployments: readonly DeploymentSummary[];
  readonly domains: readonly {
    readonly kind: "service" | "custom";
    readonly id: string;
    readonly domain: string;
    readonly targetPort: number | null;
  }[];
  readonly deployment: {
    readonly id: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly snapshotId: string;
    readonly commitHash: string;
    readonly imageDigest: string | null;
    readonly patchId: string | null;
  };
  readonly rows: readonly ColdRecoveryVariableRow[];
  readonly environmentConfigSha256: string;
  readonly stagedPatchSha256: string;
}

export interface ProviderLedger {
  readonly historyRows: readonly Json[];
  readonly patchRows: readonly Json[];
}

export interface BoundaryEvidence {
  readonly passed: boolean;
  readonly receiptSha256: string | null;
}

export interface RuntimeAbsenceEvidence {
  readonly absent: boolean;
  readonly responseSha256s: Readonly<Record<"/health" | "/startup" | "/ready", string | null>>;
  readonly requests: Readonly<Record<"/health" | "/startup" | "/ready", {
    readonly requestUrlSha256: string;
    readonly statusCode: number | null;
    readonly responseBodySha256: string | null;
  }>>;
}

export interface StopAttempt {
  readonly outcome: "acknowledged" | "transport_uncertain";
  readonly acknowledgementExact: boolean;
  readonly querySha256: string;
  readonly variablesSha256: string;
  readonly requestBodySha256: string;
  readonly responseBodySha256: string | null;
  readonly acknowledgementSha256: string | null;
}

const REVIEWED_RELEASE_POLICY_SHA256 =
  "4aaedd863d08e539e1628db5d14557cc23531a0c6d586ffb25acebcba7907e90";
const REVIEWED_BASE_CHECKS = Object.freeze([
  Object.freeze({ name: "postgres-tool-runtime-closure-observation", workflowPath: ".github/workflows/ci.yml", event: "push" }),
  Object.freeze({ name: "postgres-migration-integration", workflowPath: ".github/workflows/ci.yml", event: "push" }),
  Object.freeze({ name: "build-test-scan", workflowPath: ".github/workflows/ci.yml", event: "push" }),
  Object.freeze({ name: "supabase-database", workflowPath: ".github/workflows/ci.yml", event: "push" }),
  Object.freeze({ name: "CodeQL JavaScript and TypeScript", workflowPath: ".github/workflows/codeql.yml", event: "push" }),
  Object.freeze({ name: "CodeQL Swift", workflowPath: ".github/workflows/codeql.yml", event: "push" }),
  Object.freeze({ name: "release-readiness", workflowPath: ".github/workflows/pintpath-release-readiness.yml", event: "push" }),
  Object.freeze({ name: "ios", workflowPath: ".github/workflows/native-apps.yml", event: "push" }),
] as const);
const REVIEWED_BASE_ARTIFACTS = Object.freeze([
  Object.freeze({ name: "pintpath-mission-discovery-scale-evidence", producerCheck: "postgres-migration-integration" }),
  Object.freeze({ name: "pintpath-postgres-tool-runtime-closure-v4-observation", producerCheck: "postgres-tool-runtime-closure-observation" }),
  Object.freeze({ name: "pintpath-automated-readiness-evidence", producerCheck: "release-readiness" }),
] as const);

export interface QArtifactEvidence {
  readonly artifactId: typeof POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId;
  readonly artifactName: typeof POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactName;
  readonly artifactDigest: typeof POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest;
  readonly receiptSha256: typeof POST_Q_DEPLOYMENT_STOP_LOCK.q.receiptSha256;
  readonly intentSha256: typeof POST_Q_DEPLOYMENT_STOP_LOCK.q.intentSha256;
  readonly prerequisiteSha256: typeof POST_Q_DEPLOYMENT_STOP_LOCK.q.prerequisiteSha256;
  readonly successorBridgeSha256: typeof POST_Q_DEPLOYMENT_STOP_LOCK.q.successorBridgeSha256;
  readonly reviewedAuthoritySha256: typeof POST_Q_DEPLOYMENT_STOP_LOCK.q.reviewedAuthoritySha256;
}

export interface PostQAuthorityEvidence {
  readonly sha256: string;
  readonly currentRunId: string;
  readonly currentRunAttempt: 1;
  readonly totalWorkflowDispatchRuns: number;
  readonly priorSkippedAttemptCount: number;
  readonly qArtifactId: typeof POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId;
  readonly qArtifactDigest: typeof POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest;
  readonly singleUseAuthorityExact: true;
}

export interface ReviewedContainmentAuthorityEvidence {
  readonly sha256: string;
  readonly candidateSha: string;
  readonly reviewedPrHeadSha: string;
  readonly reviewedPullRequestNumber: number;
  readonly reviewedPullRequestMergedAt: string;
  readonly authorizationDeadline: string;
  /** Present for v2 so the executor can rederive the bounded deadline at write time. */
  readonly workflowRunStartedAt?: string;
  readonly workflowRunId: string;
  readonly workflowRunAttempt: 1;
  readonly reviewedAuthorityExact: true;
  readonly freshDispatchWriteGuardExact: true;
}

export const POST_Q_DEPLOYMENT_STOP_Q_LEAVES = Object.freeze([
  Object.freeze({
    relativePath: "pintpath-cold-github-candidate/reviewed-authority.json",
    sha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.reviewedAuthoritySha256,
  }),
  Object.freeze({
    relativePath:
      "pintpath-permanent-staging-cold-evidence/cold-quiesce-intent.json",
    sha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.intentSha256,
  }),
  Object.freeze({
    relativePath:
      "pintpath-permanent-staging-cold-evidence/cold-quiesce-receipt.json",
    sha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.receiptSha256,
  }),
  Object.freeze({
    relativePath:
      "pintpath-permanent-staging-cold-evidence/cold-quiesce-successor-bridge.json",
    sha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.successorBridgeSha256,
  }),
  Object.freeze({
    relativePath:
      "pintpath-permanent-staging-cold-evidence/prerequisites-verification.json",
    sha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.prerequisiteSha256,
  }),
] as const);

export function validatePostQArtifactSources(
  sources: Readonly<Record<string, string>>,
): QArtifactEvidence | null {
  if (canonicalPostQEvidence(Object.keys(sources).sort()) !==
    canonicalPostQEvidence(POST_Q_DEPLOYMENT_STOP_Q_LEAVES.map((leaf) =>
      leaf.relativePath).sort())) return null;
  for (const leaf of POST_Q_DEPLOYMENT_STOP_Q_LEAVES) {
    const source = sources[leaf.relativePath];
    if (source === undefined || postQSha256(source) !== leaf.sha256) return null;
  }
  try {
    const receiptSource = sources[
      "pintpath-permanent-staging-cold-evidence/cold-quiesce-receipt.json"
    ]!;
    const receipt = JSON.parse(receiptSource) as unknown;
    if (!record(receipt) || `${JSON.stringify(receipt, null, 2)}\n` !== receiptSource ||
      receipt.schemaVersion !== "pintpath-permanent-staging-cold-quiesce/v6" ||
      receipt.executorState !== "GITHUB_ENVIRONMENT_PROTECTED" ||
      receipt.operation !== "cold-quiesce" || receipt.target !== "permanent-staging" ||
      receipt.outcome !== "mutation_uncertain" ||
      receipt.failureCode !== "reconciliation_failed" ||
      receipt.candidateSha !== POST_Q_DEPLOYMENT_STOP_LOCK.q.candidateSha ||
      receipt.sourceSha !== POST_Q_DEPLOYMENT_STOP_LOCK.sourceSha ||
      receipt.attempts !== 1 || receipt.retryAllowed !== false ||
      receipt.configuredOneToZeroReceiptClaimed !== false ||
      receipt.secretMaterialIncluded !== false ||
      receipt.secretDerivedCommitmentsIncluded !== false ||
      !record(receipt.directMutationEvidence) ||
      receipt.directMutationEvidence.operation !== "environmentPatchCommit" ||
      receipt.directMutationEvidence.transportOutcome !== "acknowledged" ||
      receipt.directMutationEvidence.acknowledgementExact !== true ||
      receipt.directMutationEvidence.zeroRegionsEncodedAsJsonNull !== true ||
      !record(receipt.providerHistoryEvidence) ||
      receipt.providerHistoryEvidence.postflight !== null ||
      !record(receipt.providerEvidence) ||
      receipt.providerEvidence.stateAfterSha256 !== null ||
      receipt.providerEvidence.topologyAfterSha256 !== null ||
      !record(receipt.checks) ||
      receipt.checks.writeAttemptedAtMostOnce !== true ||
      receipt.checks.acknowledgementExact !== true ||
      receipt.checks.exactZeroStateAfter !== false ||
      receipt.checks.deploymentSourceAndTopologyUnchanged !== false ||
      receipt.nextRequiredProof !== "EXACT_CANDIDATE_UPLOAD_AT_CONFIGURED_ZERO") {
      return null;
    }
  } catch {
    return null;
  }
  return {
    artifactId: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId,
    artifactName: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactName,
    artifactDigest: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest,
    receiptSha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.receiptSha256,
    intentSha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.intentSha256,
    prerequisiteSha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.prerequisiteSha256,
    successorBridgeSha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.successorBridgeSha256,
    reviewedAuthoritySha256:
      POST_Q_DEPLOYMENT_STOP_LOCK.q.reviewedAuthoritySha256,
  };
}

export function parsePostQAuthority(
  source: string,
  expected: { readonly candidateSha: string; readonly runId: string },
): PostQAuthorityEvidence | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!exact(value, [
      "schemaVersion", "operation", "repository", "candidateSha",
      "currentRunId", "currentRunAttempt", "containment", "failedQ",
      "artifact", "qMutationDisposition", "checks", "secretMaterialIncluded",
      "secretDerivedCommitmentsIncluded",
    ]) || `${JSON.stringify(value, null, 2)}\n` !== source ||
      value.schemaVersion !== "pintpath-permanent-staging-post-q-authority/v1" ||
      value.operation !== "post-q-deployment-stop-containment" ||
      value.repository !== POST_Q_DEPLOYMENT_STOP_LOCK.repository ||
      value.candidateSha !== expected.candidateSha ||
      value.currentRunId !== expected.runId || value.currentRunAttempt !== 1 ||
      value.secretMaterialIncluded !== false ||
      value.secretDerivedCommitmentsIncluded !== false ||
      !exact(value.containment, [
        "workflowPath", "workflowId", "runId", "runNumber", "runAttempt",
        "headSha", "totalWorkflowDispatchRuns", "priorAttempts",
        "recoveryBridge",
        "workflowMetadataExact",
        "currentWriterNotStartedExact", "everyPriorWriterDefinitelySkippedExact",
        "allWorkflowRunPagesReadExact", "allRunAttemptJobPagesReadExact",
        "freshDispatchCannotRepeatWriteExact",
        "priorCompletedBeforeWriterRunsDoNotConsumeAuthority",
      ]) || !exact(value.failedQ, [
        "runId", "runAttempt", "workflowId", "workflowPath", "headSha",
        "conclusion", "bridgeStepConclusion", "soleWriterStepConclusion",
        "boundaryStepConclusion", "artifactUploadStepConclusion",
        "otherJobsSkipped",
      ]) || !exact(value.artifact, [
        "id", "name", "digest", "sizeBytes", "members",
      ]) || !exact(value.qMutationDisposition, [
        "attempts", "retryAllowed", "acknowledgementExact",
        "configuredZeroReached", "reinterpretAsZeroAllowed",
      ]) || !exact(value.checks, [
        "currentDispatchExact", "qRunExact", "qFourJobInventoryExact",
        "qSoleWriterDispositionExact", "qArtifactMetadataExact",
        "qFiveMemberCustodyExact", "qRetryPreventedExact",
        "containmentCurrentRunExact", "containmentSingleUseHistoryExact",
        "containmentSecondWritePreventedExact", "evidenceSecretFreeExact",
      ])) return null;
    const containment = value.containment;
    if (containment.workflowPath !==
        ".github/workflows/stop-permanent-staging-post-q-deployment.yml" ||
      containment.runId !== expected.runId || containment.runAttempt !== 1 ||
      containment.headSha !== expected.candidateSha ||
      containment.workflowId !==
        POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.workflowId ||
      containment.runNumber !== 2 ||
      containment.totalWorkflowDispatchRuns !== 2 ||
      !Array.isArray(containment.priorAttempts) ||
      containment.priorAttempts.length !== 1 ||
      containment.priorAttempts.some((attempt) =>
        !exact(attempt, [
          "runId", "runAttempt", "headSha", "writerDisposition",
        ]) ||
        !RUN_ID_PATTERN.test(String(attempt.runId)) ||
        attempt.runAttempt !== 1 ||
        !/^[a-f0-9]{40}$/.test(String(attempt.headSha)) ||
        attempt.writerDisposition !== "completed_skipped") ||
      containment.priorAttempts[0].runId !==
        POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.runId ||
      containment.priorAttempts[0].headSha !==
        POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.candidateSha ||
      !exact(containment.recoveryBridge, [
        "runId", "runAttempt", "workflowId", "workflowPath", "headSha",
        "prepareJobId", "applyJobId", "prepareFailedBeforeIntentExact",
        "applyCompletedSkippedWithoutStepsExact",
        "writerNeverExistedOrStartedExact", "artifactsAbsentExact",
      ]) ||
      containment.recoveryBridge.runId !==
        POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.runId ||
      containment.recoveryBridge.runAttempt !== 1 ||
      containment.recoveryBridge.workflowId !==
        POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.workflowId ||
      containment.recoveryBridge.workflowPath !==
        ".github/workflows/stop-permanent-staging-post-q-deployment.yml" ||
      containment.recoveryBridge.headSha !==
        POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.candidateSha ||
      containment.recoveryBridge.prepareJobId !==
        POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.prepareJobId ||
      containment.recoveryBridge.applyJobId !==
        POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.applyJobId ||
      containment.recoveryBridge.prepareFailedBeforeIntentExact !== true ||
      containment.recoveryBridge.applyCompletedSkippedWithoutStepsExact !== true ||
      containment.recoveryBridge.writerNeverExistedOrStartedExact !== true ||
      containment.recoveryBridge.artifactsAbsentExact !== true ||
      !containment.priorAttempts.some((attempt) =>
        attempt.runId === POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.runId &&
        attempt.runAttempt === 1 && attempt.headSha ===
          POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.candidateSha &&
        attempt.writerDisposition === "completed_skipped") ||
      containment.workflowMetadataExact !== true ||
      containment.currentWriterNotStartedExact !== true ||
      containment.everyPriorWriterDefinitelySkippedExact !== true ||
      containment.allWorkflowRunPagesReadExact !== true ||
      containment.allRunAttemptJobPagesReadExact !== true ||
      containment.freshDispatchCannotRepeatWriteExact !== true ||
      containment.priorCompletedBeforeWriterRunsDoNotConsumeAuthority !== true ||
      value.failedQ.runId !== POST_Q_DEPLOYMENT_STOP_LOCK.q.runId ||
      value.failedQ.runAttempt !== 1 || value.failedQ.workflowId !== 344383802 ||
      value.failedQ.workflowPath !==
        ".github/workflows/recover-permanent-staging-cold-zero.yml" ||
      value.failedQ.headSha !== POST_Q_DEPLOYMENT_STOP_LOCK.q.candidateSha ||
      value.failedQ.conclusion !== "failure" ||
      value.failedQ.bridgeStepConclusion !== "success" ||
      value.failedQ.soleWriterStepConclusion !== "failure" ||
      value.failedQ.boundaryStepConclusion !== "success" ||
      value.failedQ.artifactUploadStepConclusion !== "success" ||
      value.failedQ.otherJobsSkipped !== true ||
      value.artifact.id !== POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId ||
      value.artifact.name !== POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactName ||
      value.artifact.digest !== POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest ||
      value.artifact.sizeBytes !== 12561 || !Array.isArray(value.artifact.members) ||
      value.artifact.members.length !== POST_Q_DEPLOYMENT_STOP_Q_LEAVES.length ||
      value.qMutationDisposition.attempts !== 1 ||
      value.qMutationDisposition.retryAllowed !== false ||
      value.qMutationDisposition.acknowledgementExact !== true ||
      value.qMutationDisposition.configuredZeroReached !== false ||
      value.qMutationDisposition.reinterpretAsZeroAllowed !== false ||
      Object.values(value.checks).some((check) => check !== true)) return null;
    for (const expectedLeaf of POST_Q_DEPLOYMENT_STOP_Q_LEAVES) {
      const members = value.artifact.members as unknown[];
      const matches = members.filter((member) => record(member) &&
        member.path === expectedLeaf.relativePath);
      if (matches.length !== 1 || !exact(matches[0], [
        "path", "sizeBytes", "sha256", "sealedPath",
      ]) || matches[0].sha256 !== expectedLeaf.sha256 ||
        matches[0].sealedPath !== expectedLeaf.relativePath ||
        !Number.isSafeInteger(matches[0].sizeBytes) ||
        (matches[0].sizeBytes as number) < 1) return null;
    }
    return {
      sha256: postQSha256(source),
      currentRunId: expected.runId,
      currentRunAttempt: 1,
      totalWorkflowDispatchRuns: containment.totalWorkflowDispatchRuns as number,
      priorSkippedAttemptCount: containment.priorAttempts.length,
      qArtifactId: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId,
      qArtifactDigest: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest,
      singleUseAuthorityExact: true,
    };
  } catch {
    return null;
  }
}

function reviewedBaseChecksExact(
  value: unknown,
  candidateSha: string,
  mergedAt: string,
  containmentStartedAt: string,
): value is Json[] {
  if (!Array.isArray(value) || value.length !== REVIEWED_BASE_CHECKS.length) {
    return false;
  }
  const mergedAtMs = Date.parse(mergedAt);
  const containmentStartedAtMs = Date.parse(containmentStartedAt);
  return value.every((item, index) => {
    const expected = REVIEWED_BASE_CHECKS[index]!;
    if (!exact(item, [
      "name", "runId", "checkSuiteId", "workflowId", "workflowPath",
      "event", "runAttempt", "startedAt", "completedAt",
    ]) || item.name !== expected.name ||
      item.workflowPath !== expected.workflowPath || item.event !== expected.event ||
      !Number.isSafeInteger(item.runId) || (item.runId as number) <= 0 ||
      !Number.isSafeInteger(item.checkSuiteId) ||
      (item.checkSuiteId as number) <= 0 ||
      !Number.isSafeInteger(item.workflowId) || (item.workflowId as number) <= 0 ||
      item.runAttempt !== 1 || !githubTimestamp(item.startedAt) ||
      !githubTimestamp(item.completedAt)) return false;
    const startedAtMs = Date.parse(item.startedAt);
    const completedAtMs = Date.parse(item.completedAt);
    return startedAtMs >= mergedAtMs && completedAtMs > startedAtMs &&
      completedAtMs < containmentStartedAtMs && /^[a-f0-9]{40}$/.test(candidateSha);
  });
}

function reviewedBaseArtifactsExact(
  value: unknown,
  checks: readonly Json[],
): value is Json[] {
  if (!Array.isArray(value) || value.length !== REVIEWED_BASE_ARTIFACTS.length) {
    return false;
  }
  return value.every((item, index) => {
    const expected = REVIEWED_BASE_ARTIFACTS[index]!;
    const producer = checks.find((check) => check.name === expected.producerCheck);
    return exact(item, [
      "artifactId", "name", "digest", "sizeBytes", "runId", "producerCheck",
    ]) && item.name === expected.name &&
      item.producerCheck === expected.producerCheck && producer !== undefined &&
      item.runId === producer.runId && Number.isSafeInteger(item.artifactId) &&
      (item.artifactId as number) > 0 && Number.isSafeInteger(item.sizeBytes) &&
      (item.sizeBytes as number) > 0 &&
      /^sha256:[a-f0-9]{64}$/.test(String(item.digest));
  });
}

export function parseReviewedContainmentAuthority(
  source: string,
  expected: { readonly candidateSha: string; readonly runId: string },
): ReviewedContainmentAuthorityEvidence | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!exact(value, [
      "schemaVersion", "repository", "branch", "candidateSha",
      "reviewedPullRequest", "releasePolicySha256", "directParentSha",
      "recoveryBridge",
      "authorizationDeadline", "currentContainmentRun", "requiredChecks",
      "requiredArtifacts", "checks", "secretMaterialIncluded",
      "secretDerivedCommitmentsIncluded",
    ]) || `${JSON.stringify(value, null, 2)}\n` !== source ||
      value.schemaVersion !==
        "pintpath-permanent-staging-post-q-reviewed-candidate-authority/v1" ||
      value.repository !== POST_Q_DEPLOYMENT_STOP_LOCK.repository ||
      value.branch !== "main" ||
      value.candidateSha !== expected.candidateSha ||
      value.releasePolicySha256 !== REVIEWED_RELEASE_POLICY_SHA256 ||
      value.directParentSha !==
        POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.candidateSha ||
      !exact(value.recoveryBridge, [
        "candidateSha", "treeSha", "soleParentSha",
      ]) ||
      value.recoveryBridge.candidateSha !==
        POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.candidateSha ||
      value.recoveryBridge.treeSha !==
        POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.treeSha ||
      value.recoveryBridge.soleParentSha !==
        POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.soleParentSha ||
      value.authorizationDeadline !== "2026-09-08T18:57:20.000Z" ||
      !record(value.reviewedPullRequest) ||
      !exact(value.currentContainmentRun, [
        "runId", "workflowId", "workflowPath", "runAttempt", "runStartedAt",
      ]) ||
      value.currentContainmentRun.runId !== expected.runId ||
      !Number.isSafeInteger(value.currentContainmentRun.workflowId) ||
      (value.currentContainmentRun.workflowId as number) <= 0 ||
      value.currentContainmentRun.workflowPath !==
        ".github/workflows/stop-permanent-staging-post-q-deployment.yml" ||
      value.currentContainmentRun.runAttempt !== 1 ||
      !githubTimestamp(value.currentContainmentRun.runStartedAt) ||
      !exact(value.checks, [
        "mergedPullRequestAndTreeExact", "soleParentSquashShapeExact",
        "directParentExact", "currentMainTipExact", "noLaterMainDriftExact",
        "baseRequiredCheckLineageExact", "baseRequiredArtifactsExact",
        "chronologyExact", "candidateMaximumAgeHours", "fixedDeadlineExact",
        "recoveryBridgeExact",
      ]) || Object.entries(value.checks).some(([name, check]) =>
        name === "candidateMaximumAgeHours" ? check !== 168 : check !== true) ||
      value.secretMaterialIncluded !== false ||
      value.secretDerivedCommitmentsIncluded !== false ||
      !exact(value.reviewedPullRequest, [
        "number", "reviewedPrHeadSha", "mergeCommitSha", "treeSha",
        "mergedAt", "authorId", "mergedById", "githubMergeExact",
        "reviewedTreeExact", "pullRequestApprovalRequirement",
        "pullRequestApprovalRequirementExact", "linearHistoryExact",
      ]) || typeof value.reviewedPullRequest.reviewedPrHeadSha !== "string" ||
      !/^[a-f0-9]{40}$/.test(value.reviewedPullRequest.reviewedPrHeadSha) ||
      value.reviewedPullRequest.mergeCommitSha !== expected.candidateSha ||
      !/^[a-f0-9]{40}$/.test(String(value.reviewedPullRequest.treeSha)) ||
      !Number.isSafeInteger(value.reviewedPullRequest.number) ||
      !githubTimestamp(value.reviewedPullRequest.mergedAt) ||
      value.reviewedPullRequest.pullRequestApprovalRequirement !==
        "not_required" || !reviewedBaseChecksExact(
        value.requiredChecks,
        expected.candidateSha,
        value.reviewedPullRequest.mergedAt,
        value.currentContainmentRun.runStartedAt,
      ) || !reviewedBaseArtifactsExact(
        value.requiredArtifacts,
        value.requiredChecks as Json[],
      )) return null;
    for (const key of [
      "githubMergeExact", "reviewedTreeExact",
      "pullRequestApprovalRequirementExact", "linearHistoryExact",
    ] as const) {
      if (value.reviewedPullRequest[key] !== true) return null;
    }
    if (!Number.isSafeInteger(value.reviewedPullRequest.authorId) ||
      (value.reviewedPullRequest.authorId as number) <= 0 ||
      !Number.isSafeInteger(value.reviewedPullRequest.mergedById) ||
      (value.reviewedPullRequest.mergedById as number) <= 0) return null;
    return {
      sha256: postQSha256(source),
      candidateSha: expected.candidateSha,
      reviewedPrHeadSha: value.reviewedPullRequest.reviewedPrHeadSha,
      reviewedPullRequestNumber: value.reviewedPullRequest.number as number,
      reviewedPullRequestMergedAt: value.reviewedPullRequest.mergedAt,
      authorizationDeadline: "2026-09-08T18:57:20.000Z",
      workflowRunId: expected.runId,
      workflowRunAttempt: 1,
      reviewedAuthorityExact: true,
      freshDispatchWriteGuardExact: true,
    };
  } catch {
    return null;
  }
}

export interface PostQDeploymentStopIntent {
  readonly schemaVersion: typeof POST_Q_DEPLOYMENT_STOP_INTENT_SCHEMA;
  readonly operation: typeof POST_Q_DEPLOYMENT_STOP_OPERATION;
  readonly candidateSha: string;
  readonly prepareRunId: string;
  readonly prepareRunAttempt: 1;
  readonly repository: typeof POST_Q_DEPLOYMENT_STOP_LOCK.repository;
  readonly ref: typeof POST_Q_DEPLOYMENT_STOP_LOCK.ref;
  readonly expectedArtifactName: string;
  readonly qArtifact: QArtifactEvidence;
  readonly qAuthority: PostQAuthorityEvidence;
  readonly reviewedAuthority: ReviewedContainmentAuthorityEvidence;
  readonly target: {
    readonly projectId: typeof POST_Q_DEPLOYMENT_STOP_LOCK.projectId;
    readonly environmentId: typeof POST_Q_DEPLOYMENT_STOP_LOCK.environmentId;
    readonly forbiddenProductionEnvironmentId:
      typeof POST_Q_DEPLOYMENT_STOP_LOCK.forbiddenProductionEnvironmentId;
    readonly serviceId: typeof POST_Q_DEPLOYMENT_STOP_LOCK.serviceId;
    readonly serviceInstanceId: typeof POST_Q_DEPLOYMENT_STOP_LOCK.serviceInstanceId;
    readonly deploymentId: typeof POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId;
    readonly snapshotId: typeof POST_Q_DEPLOYMENT_STOP_LOCK.snapshotId;
    readonly sourceSha: typeof POST_Q_DEPLOYMENT_STOP_LOCK.sourceSha;
    readonly imageDigest: typeof POST_Q_DEPLOYMENT_STOP_LOCK.imageDigest;
    readonly deploymentPatchId: null;
    readonly qPatchId: typeof POST_Q_DEPLOYMENT_STOP_LOCK.qPatchId;
    readonly configuredRegion: typeof POST_Q_DEPLOYMENT_STOP_LOCK.configuredRegion;
    readonly configuredReplicas: 1;
  };
  readonly baseline: typeof POST_Q_DEPLOYMENT_STOP_LOCK.baseline;
  readonly boundaryPreflightReceiptSha256: string;
  readonly mutation: {
    readonly operation: "deploymentStop";
    readonly operationName: "PintPathPostQDeploymentStop";
    readonly querySha256: string;
    readonly variablesSha256: string;
    readonly requestBodySha256: string;
    readonly maximumAttempts: 1;
    readonly retryAllowed: false;
  };
  readonly reconciliation: {
    readonly stableObservationCount: 3;
    readonly stableObservationIntervalMs: 10000;
    readonly minimumStableObservationSpanMs: 20000;
    readonly maximumPollRounds: 28;
    readonly maximumObservationSpanMs: 300000;
    readonly topologyMutationAllowed: false;
  };
  readonly secretMaterialIncluded: false;
  readonly secretDerivedCommitmentsIncluded: false;
}

function record(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Json {
  return record(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function safeString(value: unknown, maximum = 4096): value is string {
  return typeof value === "string" && value.length <= maximum &&
    !/[\r\n\0]/.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function githubTimestamp(value: unknown): value is string {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))) return false;
  const normalized = new Date(value).toISOString();
  return value.includes(".") ? normalized === value :
    normalized.replace(".000Z", "Z") === value;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    sortKeys(value[key]),
  ]));
}

export function canonicalPostQEvidence(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export function postQSha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function patchKeyShape(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return { type: "array", length: value.length, items: value.map(patchKeyShape) };
  }
  if (!record(value)) return typeof value;
  const keys = Object.keys(value).sort();
  return {
    type: "object",
    keys,
    children: Object.fromEntries(keys.map((key) => [key, patchKeyShape(value[key])])),
  };
}

async function boundedBody(response: Response): Promise<string> {
  if (response.body === null) throw new Error("provider_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("provider_response_invalid");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

async function callRailway(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  if (!TOKEN.test(token)) throw new Error("token_invalid");
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      "Project-Access-Token": token,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const source = await boundedBody(response);
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(
    response.headers.get("content-type") ?? "",
  )) throw new Error("provider_response_invalid");
  const value = JSON.parse(source) as unknown;
  if (record(value) && Object.hasOwn(value, "errors")) {
    throw new Error("provider_response_invalid");
  }
  return value;
}

export function postQTokenScopeExact(value: unknown): boolean {
  return exact(value, ["data"]) && exact(value.data, ["projectToken"]) &&
    exact(value.data.projectToken, ["projectId", "environmentId"]) &&
    value.data.projectToken.projectId === POST_Q_DEPLOYMENT_STOP_LOCK.projectId &&
    value.data.projectToken.environmentId ===
      POST_Q_DEPLOYMENT_STOP_LOCK.environmentId;
}

function variableRow(value: unknown): ColdRecoveryVariableRow | null {
  if (!exact(value, [
    "id", "name", "environmentId", "serviceId", "isSealed", "references",
  ]) || !safeString(value.id, 256) || !/^[A-Z][A-Z0-9_]{0,255}$/.test(
    String(value.name),
  ) || value.environmentId !== POST_Q_DEPLOYMENT_STOP_LOCK.environmentId ||
    !(value.serviceId === null ||
      typeof value.serviceId === "string" && UUID.test(value.serviceId)) ||
    typeof value.isSealed !== "boolean" || !Array.isArray(value.references) ||
    value.references.length > 100 || value.references.some((item) =>
      !safeString(item, 512))) return null;
  return {
    id: value.id,
    name: String(value.name),
    environmentId: POST_Q_DEPLOYMENT_STOP_LOCK.environmentId,
    serviceId: value.serviceId as string | null,
    isSealed: value.isSealed,
    references: [...value.references].sort() as string[],
  };
}

function deploymentSummary(value: unknown): DeploymentSummary | null {
  return exact(value, ["id", "status", "deploymentStopped"]) &&
      UUID.test(String(value.id)) && safeString(value.status, 64) &&
      typeof value.deploymentStopped === "boolean"
    ? {
      id: String(value.id),
      status: value.status,
      deploymentStopped: value.deploymentStopped,
    }
    : null;
}

export function parsePostQDeploymentStopSnapshot(
  value: unknown,
): PostQDeploymentStopSnapshot | null {
  if (!exact(value, ["data"]) || !exact(value.data, [
    "environment", "staged", "serviceInstance", "deployment",
  ])) return null;
  const environment = value.data.environment;
  const staged = value.data.staged;
  const instance = value.data.serviceInstance;
  const deployment = value.data.deployment;
  if (!exact(environment, ["id", "config", "variables"]) ||
    environment.id !== POST_Q_DEPLOYMENT_STOP_LOCK.environmentId ||
    !exact(environment.variables, ["edges", "pageInfo"]) ||
    !Array.isArray(environment.variables.edges) ||
    !exact(environment.variables.pageInfo, ["hasNextPage", "endCursor"]) ||
    environment.variables.pageInfo.hasNextPage !== false ||
    !exact(staged, ["environmentId", "patch"]) ||
    staged.environmentId !== POST_Q_DEPLOYMENT_STOP_LOCK.environmentId ||
    !record(staged.patch) || Object.keys(staged.patch).length !== 0 ||
    !exact(instance, [
      "id", "serviceId", "environmentId", "numReplicas", "source",
      "latestDeployment", "activeDeployments", "domains",
    ]) || instance.id !== POST_Q_DEPLOYMENT_STOP_LOCK.serviceInstanceId ||
    instance.serviceId !== POST_Q_DEPLOYMENT_STOP_LOCK.serviceId ||
    instance.environmentId !== POST_Q_DEPLOYMENT_STOP_LOCK.environmentId ||
    instance.numReplicas !== null || !exact(instance.source, ["repo", "image"]) ||
    instance.source.repo !== null || instance.source.image !== null ||
    !exact(instance.latestDeployment, ["id", "status", "deploymentStopped", "snapshotId"]) ||
    instance.latestDeployment.id !== POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId ||
    !safeString(instance.latestDeployment.status, 64) ||
    typeof instance.latestDeployment.deploymentStopped !== "boolean" ||
    instance.latestDeployment.snapshotId !== POST_Q_DEPLOYMENT_STOP_LOCK.snapshotId ||
    !Array.isArray(instance.activeDeployments) ||
    !exact(instance.domains, ["serviceDomains", "customDomains"]) ||
    !Array.isArray(instance.domains.serviceDomains) ||
    !Array.isArray(instance.domains.customDomains) ||
    !exact(deployment, ["id", "projectId", "environmentId", "serviceId", "snapshotId", "meta"]) ||
    deployment.id !== POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId ||
    deployment.projectId !== POST_Q_DEPLOYMENT_STOP_LOCK.projectId ||
    deployment.environmentId !== POST_Q_DEPLOYMENT_STOP_LOCK.environmentId ||
    deployment.serviceId !== POST_Q_DEPLOYMENT_STOP_LOCK.serviceId ||
    deployment.snapshotId !== POST_Q_DEPLOYMENT_STOP_LOCK.snapshotId ||
    !record(deployment.meta) ||
    deployment.meta.commitHash !== POST_Q_DEPLOYMENT_STOP_LOCK.sourceSha ||
    deployment.meta.imageDigest !== POST_Q_DEPLOYMENT_STOP_LOCK.imageDigest ||
    deployment.meta.patchId !== POST_Q_DEPLOYMENT_STOP_LOCK.deploymentPatchId) return null;
  const environmentConfigSource = canonicalPostQEvidence(environment.config);
  const environmentConfigSha256 = postQSha256(environmentConfigSource);
  const stagedPatchSha256 = postQSha256(canonicalPostQEvidence(staged.patch));
  if (Buffer.byteLength(environmentConfigSource) > 64 * 1024 ||
    environmentConfigSha256 !==
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.environmentConfigSha256 ||
    stagedPatchSha256 !==
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.stagedPatchSha256) return null;

  const configured = parseRailwayMultiRegionReplicaTopology(
    environment.config,
    POST_Q_DEPLOYMENT_STOP_LOCK.serviceId,
  );
  const manifestDeploy = record(deployment.meta.serviceManifest) &&
      record(deployment.meta.serviceManifest.deploy)
    ? deployment.meta.serviceManifest.deploy
    : null;
  const deployed = parseRailwayMultiRegionReplicaTopology({
    services: {
      [POST_Q_DEPLOYMENT_STOP_LOCK.serviceId]: { deploy: manifestDeploy },
    },
  }, POST_Q_DEPLOYMENT_STOP_LOCK.serviceId);
  if (configured.kind !== "configured" || configured.configuredTotal !== 1 ||
    canonicalPostQEvidence(configured.regions) !== canonicalPostQEvidence([{
      region: POST_Q_DEPLOYMENT_STOP_LOCK.configuredRegion,
      numReplicas: 1,
    }]) || deployed.kind !== "configured" || deployed.configuredTotal !== 1 ||
    canonicalPostQEvidence(deployed.regions) !== canonicalPostQEvidence([{
      region: POST_Q_DEPLOYMENT_STOP_LOCK.configuredRegion,
      numReplicas: 1,
    }])) return null;

  const rows: ColdRecoveryVariableRow[] = [];
  for (const edge of environment.variables.edges) {
    if (!exact(edge, ["node"])) return null;
    const parsed = variableRow(edge.node);
    if (parsed === null) return null;
    rows.push(parsed);
  }
  rows.sort((left, right) =>
    `${left.serviceId ?? ""}:${left.name}:${left.id}`.localeCompare(
      `${right.serviceId ?? ""}:${right.name}:${right.id}`,
    ));
  if (!coldRecoveryRowsExact(rows)) return null;

  const active: DeploymentSummary[] = [];
  for (const item of instance.activeDeployments) {
    const parsed = deploymentSummary(item);
    if (parsed === null) return null;
    active.push(parsed);
  }
  active.sort((left, right) => left.id.localeCompare(right.id));
  const domains: PostQDeploymentStopSnapshot["domains"][number][] = [];
  for (const [kind, items] of [
    ["service", instance.domains.serviceDomains],
    ["custom", instance.domains.customDomains],
  ] as const) {
    for (const item of items) {
      if (!exact(item, ["id", "domain", "targetPort"]) ||
        !UUID.test(String(item.id)) || !safeString(item.domain, 253) ||
        !(item.targetPort === null || Number.isSafeInteger(item.targetPort))) return null;
      domains.push({
        kind,
        id: String(item.id),
        domain: item.domain,
        targetPort: item.targetPort as number | null,
      });
    }
  }
  domains.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(
    `${right.kind}:${right.id}`,
  ));
  return {
    environmentId: POST_Q_DEPLOYMENT_STOP_LOCK.environmentId,
    serviceInstanceId: POST_Q_DEPLOYMENT_STOP_LOCK.serviceInstanceId,
    serviceId: POST_Q_DEPLOYMENT_STOP_LOCK.serviceId,
    numReplicas: null,
    configuredReplicas: 1,
    configuredRegions: configured.regions,
    deploymentRegions: deployed.regions,
    source: { repo: null, image: null },
    latestDeployment: {
      id: POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId,
      status: instance.latestDeployment.status,
      deploymentStopped: instance.latestDeployment.deploymentStopped,
      snapshotId: POST_Q_DEPLOYMENT_STOP_LOCK.snapshotId,
    },
    activeDeployments: active,
    domains,
    deployment: {
      id: POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId,
      projectId: POST_Q_DEPLOYMENT_STOP_LOCK.projectId,
      environmentId: POST_Q_DEPLOYMENT_STOP_LOCK.environmentId,
      serviceId: POST_Q_DEPLOYMENT_STOP_LOCK.serviceId,
      snapshotId: POST_Q_DEPLOYMENT_STOP_LOCK.snapshotId,
      commitHash: POST_Q_DEPLOYMENT_STOP_LOCK.sourceSha,
      imageDigest: POST_Q_DEPLOYMENT_STOP_LOCK.imageDigest,
      patchId: POST_Q_DEPLOYMENT_STOP_LOCK.deploymentPatchId,
    },
    rows,
    environmentConfigSha256,
    stagedPatchSha256,
  };
}

export function snapshotStateSha256(snapshot: PostQDeploymentStopSnapshot): string {
  const capturedStateProjection = {
    environmentId: snapshot.environmentId,
    serviceInstanceId: snapshot.serviceInstanceId,
    serviceId: snapshot.serviceId,
    numReplicas: snapshot.numReplicas,
    configuredReplicas: snapshot.configuredReplicas,
    configuredRegions: snapshot.configuredRegions,
    deploymentRegions: snapshot.deploymentRegions,
    source: snapshot.source,
    latestDeployment: snapshot.latestDeployment,
    activeDeployments: snapshot.activeDeployments,
    domains: snapshot.domains,
    deployment: snapshot.deployment,
    rows: snapshot.rows,
  };
  return postQSha256(`${JSON.stringify(capturedStateProjection, null, 2)}\n`);
}

export function snapshotTopologySha256(
  snapshot: PostQDeploymentStopSnapshot,
): string {
  return postQSha256(canonicalPostQEvidence({
    configuredReplicas: snapshot.configuredReplicas,
    configuredRegions: snapshot.configuredRegions,
    deploymentRegions: snapshot.deploymentRegions,
    legacyReplicas: snapshot.numReplicas,
  }));
}

function offTargetRows(
  rows: readonly ColdRecoveryVariableRow[],
): readonly ColdRecoveryVariableRow[] {
  return rows.filter((row) => row.serviceId !== POST_Q_DEPLOYMENT_STOP_LOCK.serviceId);
}

export function snapshotEvidenceHashes(
  snapshot: PostQDeploymentStopSnapshot,
): {
  readonly variableInventorySha256: string;
  readonly collateralVariablesSha256: string;
  readonly offTargetVariablesSha256: string;
  readonly environmentConfigSha256: string;
  readonly stagedPatchSha256: string;
  readonly sourceIdentitySha256: string;
} {
  return {
    variableInventorySha256:
      postQSha256(canonicalPostQEvidence(snapshot.rows)),
    collateralVariablesSha256:
      postQSha256(canonicalPostQEvidence(nonMaintenanceRows(snapshot.rows))),
    offTargetVariablesSha256:
      postQSha256(canonicalPostQEvidence(offTargetRows(snapshot.rows))),
    environmentConfigSha256: snapshot.environmentConfigSha256,
    stagedPatchSha256: snapshot.stagedPatchSha256,
    sourceIdentitySha256: postQSha256(canonicalPostQEvidence({
      source: snapshot.source,
      deployment: snapshot.deployment,
    })),
  };
}

export function snapshotBaselineExact(
  snapshot: PostQDeploymentStopSnapshot,
): boolean {
  const lock = POST_Q_DEPLOYMENT_STOP_LOCK;
  const active = snapshot.activeDeployments[0];
  const targetRows = snapshot.rows.filter((row) => row.serviceId === lock.serviceId);
  const unrelated = offTargetRows(snapshot.rows);
  return snapshotStateSha256(snapshot) === lock.baseline.stateSha256 &&
    snapshotTopologySha256(snapshot) === lock.baseline.topologySha256 &&
    postQSha256(canonicalPostQEvidence(snapshot.rows)) ===
      lock.baseline.variableInventorySha256 &&
    postQSha256(canonicalPostQEvidence(nonMaintenanceRows(snapshot.rows))) ===
      lock.baseline.collateralVariablesSha256 &&
    postQSha256(canonicalPostQEvidence(unrelated)) ===
      lock.baseline.offTargetVariablesSha256 &&
    snapshot.rows.length === lock.baseline.variableRows &&
    targetRows.length === lock.baseline.targetVariableRows &&
    unrelated.length === lock.baseline.offTargetVariableRows &&
    snapshot.rows.filter((row) => row.serviceId === null).length ===
      lock.baseline.nullServiceVariableRows &&
    snapshot.environmentConfigSha256 ===
      lock.baseline.environmentConfigSha256 &&
    snapshot.stagedPatchSha256 === lock.baseline.stagedPatchSha256 &&
    snapshotEvidenceHashes(snapshot).sourceIdentitySha256 ===
      lock.baseline.sourceIdentitySha256 &&
    snapshot.latestDeployment.status === "SUCCESS" &&
    snapshot.latestDeployment.deploymentStopped === false &&
    snapshot.activeDeployments.length === 1 &&
    active?.id === lock.deploymentId && active.status === "SUCCESS" &&
    active.deploymentStopped === false && snapshot.domains.length === 1 &&
    snapshot.domains[0]?.kind === "service" &&
    snapshot.domains[0]?.id === lock.domainId &&
    snapshot.domains[0]?.domain === lock.domain &&
    snapshot.domains[0]?.targetPort === lock.targetPort;
}

function snapshotCollateral(snapshot: PostQDeploymentStopSnapshot): unknown {
  return {
    environmentId: snapshot.environmentId,
    serviceInstanceId: snapshot.serviceInstanceId,
    serviceId: snapshot.serviceId,
    numReplicas: snapshot.numReplicas,
    configuredReplicas: snapshot.configuredReplicas,
    configuredRegions: snapshot.configuredRegions,
    deploymentRegions: snapshot.deploymentRegions,
    source: snapshot.source,
    domains: snapshot.domains,
    deployment: snapshot.deployment,
    rows: snapshot.rows,
    environmentConfigSha256: snapshot.environmentConfigSha256,
    stagedPatchSha256: snapshot.stagedPatchSha256,
  };
}

export function stoppedSnapshotExact(
  before: PostQDeploymentStopSnapshot,
  after: PostQDeploymentStopSnapshot,
): boolean {
  return canonicalPostQEvidence(snapshotCollateral(after)) ===
      canonicalPostQEvidence(snapshotCollateral(before)) &&
    after.latestDeployment.id === before.latestDeployment.id &&
    after.latestDeployment.snapshotId === before.latestDeployment.snapshotId &&
    before.latestDeployment.status === "SUCCESS" &&
    after.latestDeployment.status === "SUCCESS" &&
    after.latestDeployment.deploymentStopped === true &&
    after.activeDeployments.length === 0;
}

function parseHistoryNode(value: unknown): Json | null {
  if (!exact(value, [
    "id", "createdAt", "object", "action", "outcome", "operationKind",
    "severity", "source", "workflowId", "activityPayload",
  ]) || !UUID.test(String(value.id)) || !timestamp(value.createdAt) ||
    !["object", "action", "outcome", "operationKind", "severity", "source"]
      .every((key) => safeString(value[key], 256)) ||
    !(value.workflowId === null || safeString(value.workflowId, 256)) ||
    !record(value.activityPayload)) return null;
  const payloadSource = canonicalPostQEvidence(value.activityPayload);
  if (Buffer.byteLength(payloadSource) > 16_384) return null;
  return {
    id: value.id,
    createdAt: value.createdAt,
    object: value.object,
    action: value.action,
    outcome: value.outcome,
    operationKind: value.operationKind,
    severity: value.severity,
    source: value.source,
    workflowId: value.workflowId,
    activityPayload: sortKeys(value.activityPayload),
  };
}

function parsePatchNode(value: unknown): Json | null {
  if (!exact(value, [
    "id", "environmentId", "status", "createdAt", "updatedAt", "appliedAt",
    "message", "patch",
  ]) || !UUID.test(String(value.id)) ||
    value.environmentId !== POST_Q_DEPLOYMENT_STOP_LOCK.environmentId ||
    !safeString(value.status, 64) || !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    !(value.appliedAt === null || timestamp(value.appliedAt)) ||
    !(value.message === null || safeString(value.message, 512)) ||
    !record(value.patch)) return null;
  return {
    id: value.id,
    environmentId: value.environmentId,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    appliedAt: value.appliedAt,
    message: value.message,
    patchKeyShape: patchKeyShape(value.patch),
  };
}

interface ConnectionPage {
  readonly rows: readonly Json[];
  readonly next: string | null;
}

function parseConnection(
  value: unknown,
  field: "environmentHistory" | "environmentPatches",
  parseNode: (value: unknown) => Json | null,
): ConnectionPage | null {
  if (!exact(value, ["data"]) || !exact(value.data, [field])) return null;
  const connection = value.data[field];
  if (!exact(connection, ["edges", "pageInfo"]) ||
    !Array.isArray(connection.edges) || connection.edges.length < 1 ||
    connection.edges.length > 100 ||
    !exact(connection.pageInfo, ["hasNextPage", "endCursor"]) ||
    typeof connection.pageInfo.hasNextPage !== "boolean" ||
    !safeString(connection.pageInfo.endCursor, 1024)) return null;
  const rows: Json[] = [];
  const cursors = new Set<string>();
  for (const edge of connection.edges) {
    if (!exact(edge, ["cursor", "node"]) || !safeString(edge.cursor, 1024) ||
      edge.cursor.length === 0 || cursors.has(edge.cursor)) return null;
    cursors.add(edge.cursor);
    const row = parseNode(edge.node);
    if (row === null) return null;
    rows.push(row);
  }
  if (connection.edges.at(-1)?.cursor !== connection.pageInfo.endCursor ||
    connection.pageInfo.hasNextPage && rows.length !== 100) return null;
  return {
    rows,
    next: connection.pageInfo.hasNextPage
      ? String(connection.pageInfo.endCursor)
      : null,
  };
}

async function collect(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  field: "environmentHistory" | "environmentPatches",
  parseNode: (value: unknown) => Json | null,
): Promise<readonly Json[]> {
  const rows: Json[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 2; page += 1) {
    const variables = field === "environmentHistory"
      ? {
        environmentId: POST_Q_DEPLOYMENT_STOP_LOCK.environmentId,
        serviceId: POST_Q_DEPLOYMENT_STOP_LOCK.serviceId,
        after,
      }
      : { environmentId: POST_Q_DEPLOYMENT_STOP_LOCK.environmentId, after };
    const parsed = parseConnection(
      await callRailway(fetchImpl, token, query, variables),
      field,
      parseNode,
    );
    if (parsed === null || parsed.next !== null && cursors.has(parsed.next)) {
      throw new Error("provider_ledger_invalid");
    }
    if (parsed.rows.length < 1 || parsed.rows.length > 100 ||
      parsed.next !== null && parsed.rows.length !== 100 ||
      page === 1 && parsed.next !== null) {
      throw new Error("provider_ledger_invalid");
    }
    rows.push(...parsed.rows);
    if (parsed.next === null) return rows;
    cursors.add(parsed.next);
    after = parsed.next;
  }
  throw new Error("provider_ledger_invalid");
}

export async function readPostQProviderLedger(
  fetchImpl: typeof fetch,
  token: string,
): Promise<ProviderLedger> {
  const [historyRows, patchRows] = await Promise.all([
    collect(fetchImpl, token, POST_Q_DEPLOYMENT_STOP_HISTORY_QUERY,
      "environmentHistory", parseHistoryNode),
    collect(fetchImpl, token, POST_Q_DEPLOYMENT_STOP_PATCHES_QUERY,
      "environmentPatches", parsePatchNode),
  ]);
  return { historyRows, patchRows };
}

const Q_HISTORY_ROWS = Object.freeze([
  Object.freeze({
    id: "650b3b06-0320-43d4-9359-f319a316878e",
    createdAt: "2026-09-08T13:11:11.634Z",
    action: "deployed",
    status: "SUCCESS",
  }),
  Object.freeze({
    id: "3ae50c9c-620d-458d-b29f-ac23ee5ce575",
    createdAt: "2026-09-08T13:10:41.008Z",
    action: "deploying",
    status: "DEPLOYING",
  }),
  Object.freeze({
    id: "cd049a7f-9e08-41f8-948b-824825e2e8e1",
    createdAt: "2026-09-08T13:09:27.503Z",
    action: "building",
    status: "BUILDING",
  }),
  Object.freeze({
    id: "e114d7de-140c-49b3-887a-a85ff796b9e7",
    createdAt: "2026-09-08T13:09:25.527Z",
    action: "redeployed",
    status: "INITIALIZING",
  }),
] as const);

function qHistoryRowsExact(rows: readonly Json[]): boolean {
  if (rows.length < Q_HISTORY_ROWS.length) return false;
  return Q_HISTORY_ROWS.every((expected, index) => {
    const row = rows[index];
    return row?.id === expected.id && row.createdAt === expected.createdAt &&
      row.object === "Deployment" && row.action === expected.action &&
      row.outcome === "" && row.operationKind === "" &&
      row.severity === "INFO" && row.source === "event" &&
      row.workflowId === null && exact(row.activityPayload, [
        "id", "serviceId", "status",
      ]) && row.activityPayload.id === POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId &&
      row.activityPayload.serviceId === POST_Q_DEPLOYMENT_STOP_LOCK.serviceId &&
      row.activityPayload.status === expected.status;
  }) && postQSha256(canonicalPostQEvidence(rows.slice(0, 4))) ===
    POST_Q_DEPLOYMENT_STOP_LOCK.baseline.qHistoryRowsSha256;
}

function qPatchExact(row: Json | undefined): boolean {
  if (!row || row.id !== POST_Q_DEPLOYMENT_STOP_LOCK.qPatchId ||
    row.environmentId !== POST_Q_DEPLOYMENT_STOP_LOCK.environmentId ||
    row.status !== "COMMITTED" || row.createdAt !== "2026-09-08T13:09:24.380Z" ||
    row.updatedAt !== "2026-09-08T13:09:25.340Z" ||
    row.appliedAt !== "2026-09-08T13:09:25.339Z" ||
    row.message !==
      "PintPath cold quiesce 606d33facb515dd10bc94c360e43c20beb999cc1 run 34229745722") {
    return false;
  }
  return postQSha256(canonicalPostQEvidence([row])) ===
    POST_Q_DEPLOYMENT_STOP_LOCK.baseline.qPatchProjectionSha256;
}

export function providerLedgerBaselineExact(ledger: ProviderLedger): boolean {
  const baseline = POST_Q_DEPLOYMENT_STOP_LOCK.baseline;
  return ledger.historyRows.length === baseline.historyCount &&
    postQSha256(canonicalPostQEvidence(ledger.historyRows)) ===
      baseline.historyRowsSha256 && qHistoryRowsExact(ledger.historyRows) &&
    ledger.patchRows.length === baseline.patchCount &&
    postQSha256(canonicalPostQEvidence(ledger.patchRows)) ===
      baseline.patchRowsSha256 &&
    qPatchExact(ledger.patchRows.find((row) =>
      row.id === POST_Q_DEPLOYMENT_STOP_LOCK.qPatchId));
}

export interface ProviderLedgerPostflightEvidence {
  readonly exact: boolean;
  readonly mode: "unchanged" | "invalid";
  readonly historyRowsSha256: string;
  readonly patchRowsSha256: string;
  readonly addedHistoryRowSha256: string | null;
  readonly addedHistoryRowCount: number;
  readonly addedHistoryRowPosition: "newest-prefix" | null;
}

export function providerLedgerBoundedDelta(
  before: ProviderLedger,
  after: ProviderLedger,
  _bounds?: {
    readonly requestStartedAt: string;
    readonly observedAt: string;
  },
): Pick<ProviderLedgerPostflightEvidence,
  "mode" | "addedHistoryRowSha256" | "addedHistoryRowCount" |
  "addedHistoryRowPosition"> | null {
  if (canonicalPostQEvidence(after.patchRows) !==
    canonicalPostQEvidence(before.patchRows)) return null;
  if (canonicalPostQEvidence(after.historyRows) ===
    canonicalPostQEvidence(before.historyRows)) {
    return {
      mode: "unchanged",
      addedHistoryRowSha256: null,
      addedHistoryRowCount: 0,
      addedHistoryRowPosition: null,
    };
  }
  return null;
}

export function assessProviderLedgerPostflight(
  before: ProviderLedger,
  after: ProviderLedger,
  bounds?: {
    readonly requestStartedAt: string;
    readonly observedAt: string;
  },
): ProviderLedgerPostflightEvidence {
  const evidence = (exactResult: boolean,
    mode: ProviderLedgerPostflightEvidence["mode"],
    addedHistoryRowSha256: string | null,
    addedHistoryRowCount: number,
    addedHistoryRowPosition: "newest-prefix" | null,
  ): ProviderLedgerPostflightEvidence => ({
    exact: exactResult,
    mode,
    historyRowsSha256: postQSha256(canonicalPostQEvidence(after.historyRows)),
    patchRowsSha256: postQSha256(canonicalPostQEvidence(after.patchRows)),
    addedHistoryRowSha256,
    addedHistoryRowCount,
    addedHistoryRowPosition,
  });
  const delta = providerLedgerBoundedDelta(before, after, bounds);
  const addedHistoryRowCount = delta === null &&
      canonicalPostQEvidence(after.patchRows) ===
        canonicalPostQEvidence(before.patchRows) &&
      after.historyRows.length > before.historyRows.length &&
      canonicalPostQEvidence(after.historyRows.slice(
        after.historyRows.length - before.historyRows.length,
      )) ===
        canonicalPostQEvidence(before.historyRows)
    ? after.historyRows.length - before.historyRows.length
    : 0;
  const addedHistoryRowSha256 = addedHistoryRowCount === 1
    ? postQSha256(canonicalPostQEvidence(after.historyRows[0]))
    : null;
  const addedHistoryRowPosition = addedHistoryRowCount > 0
    ? "newest-prefix" as const
    : null;
  if (!providerLedgerBaselineExact(before)) {
    return evidence(
      false,
      "invalid",
      addedHistoryRowSha256,
      addedHistoryRowCount,
      addedHistoryRowPosition,
    );
  }
  return delta === null
    ? evidence(
      false,
      "invalid",
      addedHistoryRowSha256,
      addedHistoryRowCount,
      addedHistoryRowPosition,
    )
    : evidence(
      true,
      delta.mode,
      delta.addedHistoryRowSha256,
      delta.addedHistoryRowCount,
      delta.addedHistoryRowPosition,
    );
}

export function providerLedgerPostflightExact(
  before: ProviderLedger,
  after: ProviderLedger,
  bounds?: {
    readonly requestStartedAt: string;
    readonly observedAt: string;
  },
): boolean {
  return assessProviderLedgerPostflight(before, after, bounds).exact;
}

export async function readPostQDeploymentStopSnapshot(
  fetchImpl: typeof fetch,
  token: string,
): Promise<PostQDeploymentStopSnapshot | null> {
  try {
    return parsePostQDeploymentStopSnapshot(await callRailway(
      fetchImpl,
      token,
      POST_Q_DEPLOYMENT_STOP_STATE_QUERY,
      {
        projectId: POST_Q_DEPLOYMENT_STOP_LOCK.projectId,
        environmentId: POST_Q_DEPLOYMENT_STOP_LOCK.environmentId,
        serviceId: POST_Q_DEPLOYMENT_STOP_LOCK.serviceId,
        deploymentId: POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId,
      },
    ));
  } catch {
    return null;
  }
}

export async function readPostQTokenScope(
  fetchImpl: typeof fetch,
  token: string,
): Promise<unknown> {
  return callRailway(fetchImpl, token, POST_Q_DEPLOYMENT_STOP_SCOPE_QUERY, {});
}

export async function stopPostQDeployment(
  fetchImpl: typeof fetch,
  token: string,
): Promise<StopAttempt> {
  if (!TOKEN.test(token)) throw new Error("token_invalid");
  const body = buildPostQDeploymentStopRequestBody();
  const base = {
    querySha256: postQSha256(POST_Q_DEPLOYMENT_STOP_MUTATION),
    variablesSha256: postQSha256(JSON.stringify(POST_Q_DEPLOYMENT_STOP_VARIABLES)),
    requestBodySha256: postQSha256(body),
  };
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        "Project-Access-Token": token,
        accept: "application/json",
        "content-type": "application/json",
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const source = await boundedBody(response);
    const responseBodySha256 = postQSha256(source);
    if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    )) return {
      ...base,
      outcome: "transport_uncertain",
      acknowledgementExact: false,
      responseBodySha256,
      acknowledgementSha256: null,
    };
    const value = JSON.parse(source) as unknown;
    const acknowledged = exact(value, ["data"]) &&
      exact(value.data, ["deploymentStop"]) &&
      value.data.deploymentStop === true;
    return {
      ...base,
      outcome: acknowledged ? "acknowledged" : "transport_uncertain",
      acknowledgementExact: acknowledged,
      responseBodySha256,
      acknowledgementSha256: acknowledged
        ? postQSha256(canonicalPostQEvidence({ deploymentStop: true }))
        : null,
    };
  } catch {
    return {
      ...base,
      outcome: "transport_uncertain",
      acknowledgementExact: false,
      responseBodySha256: null,
      acknowledgementSha256: null,
    };
  }
}

export async function probePostQRuntimeAbsence(
  fetchImpl: typeof fetch,
  nonceFactory: () => string = () => crypto.randomBytes(16).toString("hex"),
): Promise<RuntimeAbsenceEvidence> {
  const routes = ["/health", "/startup", "/ready"] as const;
  const nonces = routes.map(() => nonceFactory());
  if (new Set(nonces).size !== routes.length || nonces.some((nonce) =>
    !/^[a-f0-9]{32}$/.test(nonce))) throw new Error("runtime_nonce_invalid");
  const results = await Promise.all(routes.map(async (route) => {
    const nonce = nonces[routes.indexOf(route)]!;
    const url = `${POST_Q_DEPLOYMENT_STOP_LOCK.publicOrigin}${route}` +
      `?pintpath_post_q_stop_probe=${nonce}`;
    try {
      const response = await fetchImpl(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "cache-control": "no-cache, no-store",
            pragma: "no-cache",
          },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
      const source = await boundedBody(response);
      return {
        absent: !response.ok,
        sha256: postQSha256(source),
        requestUrlSha256: postQSha256(url),
        statusCode: response.status,
      };
    } catch {
      return {
        absent: false,
        sha256: null,
        requestUrlSha256: postQSha256(url),
        statusCode: null,
      };
    }
  }));
  return {
    absent: results.every((result) => result.absent),
    responseSha256s: {
      "/health": results[0]!.sha256,
      "/startup": results[1]!.sha256,
      "/ready": results[2]!.sha256,
    },
    requests: {
      "/health": {
        requestUrlSha256: results[0]!.requestUrlSha256,
        statusCode: results[0]!.statusCode,
        responseBodySha256: results[0]!.sha256,
      },
      "/startup": {
        requestUrlSha256: results[1]!.requestUrlSha256,
        statusCode: results[1]!.statusCode,
        responseBodySha256: results[1]!.sha256,
      },
      "/ready": {
        requestUrlSha256: results[2]!.requestUrlSha256,
        statusCode: results[2]!.statusCode,
        responseBodySha256: results[2]!.sha256,
      },
    },
  };
}

export function buildPostQDeploymentStopIntent(input: {
  readonly candidateSha: string;
  readonly runId: string;
  readonly qArtifact: QArtifactEvidence;
  readonly qAuthority: PostQAuthorityEvidence;
  readonly reviewedAuthority: ReviewedContainmentAuthorityEvidence;
  readonly boundaryReceiptSha256: string;
}): PostQDeploymentStopIntent | null {
  if (!/^[a-f0-9]{40}$/.test(input.candidateSha) ||
    !/^[1-9][0-9]{0,19}$/.test(input.runId) ||
    !SHA256.test(input.boundaryReceiptSha256) ||
    canonicalPostQEvidence(input.qArtifact) !== canonicalPostQEvidence({
      artifactId: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId,
      artifactName: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactName,
      artifactDigest: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest,
      receiptSha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.receiptSha256,
      intentSha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.intentSha256,
      prerequisiteSha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.prerequisiteSha256,
      successorBridgeSha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.successorBridgeSha256,
      reviewedAuthoritySha256:
        POST_Q_DEPLOYMENT_STOP_LOCK.q.reviewedAuthoritySha256,
    }) || input.qAuthority.currentRunId !== input.runId ||
    input.qAuthority.currentRunAttempt !== 1 ||
    input.qAuthority.qArtifactId !== POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId ||
    input.qAuthority.qArtifactDigest !==
      POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest ||
    input.qAuthority.singleUseAuthorityExact !== true ||
    input.reviewedAuthority.candidateSha !== input.candidateSha ||
    input.reviewedAuthority.workflowRunId !== input.runId ||
    input.reviewedAuthority.workflowRunAttempt !== 1 ||
    input.reviewedAuthority.reviewedAuthorityExact !== true ||
    input.reviewedAuthority.freshDispatchWriteGuardExact !== true) return null;
  const requestBody = buildPostQDeploymentStopRequestBody();
  return {
    schemaVersion: POST_Q_DEPLOYMENT_STOP_INTENT_SCHEMA,
    operation: POST_Q_DEPLOYMENT_STOP_OPERATION,
    candidateSha: input.candidateSha,
    prepareRunId: input.runId,
    prepareRunAttempt: 1,
    repository: POST_Q_DEPLOYMENT_STOP_LOCK.repository,
    ref: POST_Q_DEPLOYMENT_STOP_LOCK.ref,
    expectedArtifactName:
      `pintpath-permanent-staging-post-q-deployment-stop-intent-${input.candidateSha}-${input.runId}`,
    qArtifact: input.qArtifact,
    qAuthority: input.qAuthority,
    reviewedAuthority: input.reviewedAuthority,
    target: {
      projectId: POST_Q_DEPLOYMENT_STOP_LOCK.projectId,
      environmentId: POST_Q_DEPLOYMENT_STOP_LOCK.environmentId,
      forbiddenProductionEnvironmentId:
        POST_Q_DEPLOYMENT_STOP_LOCK.forbiddenProductionEnvironmentId,
      serviceId: POST_Q_DEPLOYMENT_STOP_LOCK.serviceId,
      serviceInstanceId: POST_Q_DEPLOYMENT_STOP_LOCK.serviceInstanceId,
      deploymentId: POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId,
      snapshotId: POST_Q_DEPLOYMENT_STOP_LOCK.snapshotId,
      sourceSha: POST_Q_DEPLOYMENT_STOP_LOCK.sourceSha,
      imageDigest: POST_Q_DEPLOYMENT_STOP_LOCK.imageDigest,
      deploymentPatchId: POST_Q_DEPLOYMENT_STOP_LOCK.deploymentPatchId,
      qPatchId: POST_Q_DEPLOYMENT_STOP_LOCK.qPatchId,
      configuredRegion: POST_Q_DEPLOYMENT_STOP_LOCK.configuredRegion,
      configuredReplicas: 1,
    },
    baseline: POST_Q_DEPLOYMENT_STOP_LOCK.baseline,
    boundaryPreflightReceiptSha256: input.boundaryReceiptSha256,
    mutation: {
      operation: "deploymentStop",
      operationName: "PintPathPostQDeploymentStop",
      querySha256: postQSha256(POST_Q_DEPLOYMENT_STOP_MUTATION),
      variablesSha256:
        postQSha256(JSON.stringify(POST_Q_DEPLOYMENT_STOP_VARIABLES)),
      requestBodySha256: postQSha256(requestBody),
      maximumAttempts: 1,
      retryAllowed: false,
    },
    reconciliation: {
      stableObservationCount: 3,
      stableObservationIntervalMs: 10000,
      minimumStableObservationSpanMs: 20000,
      maximumPollRounds: 28,
      maximumObservationSpanMs: 300000,
      topologyMutationAllowed: false,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
}

export function parsePostQDeploymentStopIntent(
  source: string,
  expected: { readonly candidateSha: string; readonly runId: string },
): PostQDeploymentStopIntent | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value) || canonicalPostQEvidence(value) !== source) return null;
    const rebuilt = buildPostQDeploymentStopIntent({
      candidateSha: expected.candidateSha,
      runId: expected.runId,
      qArtifact: value.qArtifact as QArtifactEvidence,
      qAuthority: value.qAuthority as PostQAuthorityEvidence,
      reviewedAuthority:
        value.reviewedAuthority as ReviewedContainmentAuthorityEvidence,
      boundaryReceiptSha256: String(value.boundaryPreflightReceiptSha256),
    });
    return rebuilt !== null && canonicalPostQEvidence(rebuilt) === source
      ? rebuilt
      : null;
  } catch {
    return null;
  }
}

export async function reconcileStoppedDeployment(input: {
  readonly before: PostQDeploymentStopSnapshot;
  readonly beforeLedger: ProviderLedger;
  readonly requestStartedAt: string;
  readonly readSnapshot: () => Promise<PostQDeploymentStopSnapshot | null>;
  readonly readLedger: () => Promise<ProviderLedger>;
  readonly probeRuntime: () => Promise<RuntimeAbsenceEvidence>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly monotonicNow: () => number;
  readonly wallNow: () => number;
  readonly assessLedger?: typeof assessProviderLedgerPostflight;
}): Promise<{
  readonly exact: boolean;
  readonly rounds: number;
  readonly stableObservations: number;
  readonly stableSpanMs: number;
  readonly snapshot: PostQDeploymentStopSnapshot | null;
  readonly runtime: RuntimeAbsenceEvidence | null;
  readonly ledger: ProviderLedger | null;
  readonly ledgerEvidence: ProviderLedgerPostflightEvidence | null;
  readonly observations: readonly {
    readonly observedAt: string;
    readonly monotonicMs: number;
    readonly snapshotSha256: string;
    readonly topologySha256: string;
    readonly historyRowsSha256: string;
    readonly patchRowsSha256: string;
    readonly runtimeResponseSha256s: RuntimeAbsenceEvidence["responseSha256s"];
    readonly runtimeRequests: RuntimeAbsenceEvidence["requests"];
  }[];
  readonly totalObservationSpanMs: number;
}> {
  const assessLedger = input.assessLedger ?? assessProviderLedgerPostflight;
  let previousCanonical: string | null = null;
  let stable = 0;
  let latest: PostQDeploymentStopSnapshot | null = null;
  let runtime: RuntimeAbsenceEvidence | null = null;
  let latestLedger: ProviderLedger | null = null;
  let latestLedgerEvidence: ProviderLedgerPostflightEvidence | null = null;
  let firstStableAt: number | null = null;
  let previousObservedAt: number | null = null;
  let previousWallAt: number | null = null;
  let observations: Array<{
    observedAt: string;
    monotonicMs: number;
    snapshotSha256: string;
    topologySha256: string;
    historyRowsSha256: string;
    patchRowsSha256: string;
    runtimeResponseSha256s: RuntimeAbsenceEvidence["responseSha256s"];
    runtimeRequests: RuntimeAbsenceEvidence["requests"];
  }> = [];
  const observationStartedAt = input.monotonicNow();
  if (!Number.isFinite(observationStartedAt)) {
    throw new Error("observation_clock_invalid");
  }
  let lastClock = observationStartedAt;
  let totalObservationSpanMs = 0;
  const checkpoint = (requiredRemainingMs: number): boolean => {
    const current = input.monotonicNow();
    if (!Number.isFinite(current) || current < lastClock) return false;
    lastClock = current;
    totalObservationSpanMs = current - observationStartedAt;
    return totalObservationSpanMs >= 0 && totalObservationSpanMs <=
      POST_Q_DEPLOYMENT_STOP_LOCK.maximumObservationSpanMs -
        requiredRemainingMs;
  };
  const result = (exactResult: boolean, rounds: number) => ({
    exact: exactResult,
    rounds,
    stableObservations: stable,
    stableSpanMs: firstStableAt === null || previousObservedAt === null
      ? 0
      : previousObservedAt - firstStableAt,
    snapshot: latest,
    runtime,
    ledger: latestLedger,
    ledgerEvidence: latestLedgerEvidence,
    observations,
    totalObservationSpanMs,
  });
  for (let round = 1; round <= POST_Q_DEPLOYMENT_STOP_LOCK.maximumPollRounds;
    round += 1) {
    if (!checkpoint(75_000)) {
      return result(false, round - 1);
    }
    latest = await input.readSnapshot();
    if (!checkpoint(55_000)) {
      return result(false, round);
    }
    runtime = latest !== null && stoppedSnapshotExact(input.before, latest)
      ? await input.probeRuntime()
      : null;
    if (!checkpoint(40_000)) {
      return result(false, round);
    }
    latestLedger = latest !== null && runtime?.absent === true
      ? await input.readLedger()
      : null;
    if (!checkpoint(0)) {
      return result(false, round);
    }
    const wallMs = input.wallNow();
    const observedAt = Number.isFinite(wallMs)
      ? new Date(wallMs).toISOString()
      : "invalid";
    latestLedgerEvidence = latestLedger === null || !timestamp(observedAt)
      ? null
      : assessLedger(input.beforeLedger, latestLedger, {
        requestStartedAt: input.requestStartedAt,
        observedAt,
      });
    if (latest !== null && runtime?.absent === true &&
      stoppedSnapshotExact(input.before, latest) && latestLedger !== null &&
      latestLedgerEvidence?.exact === true) {
      const monotonicMs = lastClock;
      if (wallMs <
        Date.parse(input.requestStartedAt) || previousWallAt !== null &&
        wallMs < previousWallAt || previousObservedAt !== null &&
        monotonicMs - previousObservedAt <
          POST_Q_DEPLOYMENT_STOP_LOCK.stableObservationIntervalMs) {
        return result(false, round);
      }
      const currentCanonical = canonicalPostQEvidence({
        snapshot: latest,
        ledger: latestLedger,
        runtime: {
          absent: runtime.absent,
          routes: Object.fromEntries(Object.entries(runtime.requests).map(
            ([route, evidence]) => [route, {
              statusCode: evidence.statusCode,
            }],
          )),
        },
      });
      if (currentCanonical === previousCanonical) {
        stable += 1;
      } else {
        stable = 1;
        firstStableAt = monotonicMs;
        observations = [];
      }
      previousObservedAt = monotonicMs;
      previousWallAt = wallMs;
      previousCanonical = currentCanonical;
      observations.push({
        observedAt,
        monotonicMs,
        snapshotSha256: snapshotStateSha256(latest),
        topologySha256: snapshotTopologySha256(latest),
        historyRowsSha256: latestLedgerEvidence.historyRowsSha256,
        patchRowsSha256: latestLedgerEvidence.patchRowsSha256,
        runtimeResponseSha256s: runtime.responseSha256s,
        runtimeRequests: runtime.requests,
      });
      const stableSpanMs = firstStableAt === null ? 0 : monotonicMs - firstStableAt;
      if (stable === POST_Q_DEPLOYMENT_STOP_LOCK.stableObservationCount &&
        stableSpanMs >= POST_Q_DEPLOYMENT_STOP_LOCK.minimumStableObservationSpanMs) {
        if (!checkpoint(0)) return result(false, round);
        return result(true, round);
      }
    } else {
      stable = 0;
      previousCanonical = null;
      firstStableAt = null;
      previousObservedAt = null;
      previousWallAt = null;
      observations = [];
      if (latest !== null &&
        canonicalPostQEvidence(snapshotCollateral(latest)) !==
          canonicalPostQEvidence(snapshotCollateral(input.before))) {
        return result(false, round);
      }
    }
    if (round < POST_Q_DEPLOYMENT_STOP_LOCK.maximumPollRounds) {
      if (!checkpoint(
        POST_Q_DEPLOYMENT_STOP_LOCK.stableObservationIntervalMs + 75_000,
      )) {
        return result(false, round);
      }
      await input.sleep(POST_Q_DEPLOYMENT_STOP_LOCK.stableObservationIntervalMs);
      if (!checkpoint(75_000)) {
        return result(false, round);
      }
    }
  }
  return result(false, POST_Q_DEPLOYMENT_STOP_LOCK.maximumPollRounds);
}

export const postQDeploymentStopInternals = Object.freeze({
  callRailway,
  assessProviderLedgerPostflight,
  patchKeyShape,
  parseHistoryNode,
  parsePatchNode,
  snapshotCollateral,
  sortKeys,
});
