import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRODUCTION_ROUTE_CLOSE_MUTATION,
  PRODUCTION_ROUTE_OPEN_MUTATION,
  PROTECTED_PRODUCTION_ROUTE_MUTATION_SCHEMA,
  PROTECTED_PRODUCTION_ROUTE_MUTATION_STATE,
  protectedProductionRouteMutationInternals,
  runProtectedProductionRouteMutation,
} from "../scripts/execute-protected-production-route-mutation.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";
import { buildProductionPromotionRecoveryReceipt } from
  "../src/lib/production-promotion-recovery.js";

const CANDIDATE = "a".repeat(40);
const PROJECT = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const PRODUCTION = "13dab015-df74-45c6-b26f-69323daea99a";
const SERVICE = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const INSTANCE = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT = "33333333-3333-4333-8333-333333333333";
const CUSTOM_ROUTE = "44444444-4444-4444-8444-444444444444";
const OTHER_ROUTE = "55555555-5555-4555-8555-555555555555";
const temporaryRoots: string[] = [];
const RELEASE_POLICY_SHA256 =
  "b47f562d94b462ed7d2b1d9df317ac239a607d517bb487c109585e09213ba4fd";
const ROUTE_POLICY_SHA256 =
  "fc3fba0dc43f82b0fb14d5fbc48bf4ceac98f6d19a73d97504665a5d7bb13ff4";
const PROMOTION_RECOVERY_POLICY_SHA256 =
  "57f66c1c9dde912586ec510e37c28cc3dfea2c098e67c78edbea189c7dcc9988";

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function scope() {
  return { data: { projectToken: { projectId: PROJECT, environmentId: PRODUCTION } } };
}
function patchEmpty() {
  return {
    data: {
      environment: { id: PRODUCTION },
      staged: { environmentId: PRODUCTION, patch: {} },
    },
  };
}
function route(id = CUSTOM_ROUTE, domain = "pintpath.au") {
  return { id, domain, targetPort: null };
}
function inventory(
  routePresent: boolean,
  collateralDomain = "other.up.railway.app",
  replicas: 1 | 2 = 2,
) {
  return {
    data: {
      environment: {
        id: PRODUCTION,
        serviceInstances: {
          edges: [{
            node: {
              id: INSTANCE,
              serviceId: SERVICE,
              serviceName: "Beer",
              environmentId: PRODUCTION,
              numReplicas: replicas,
              latestDeployment: {
                id: DEPLOYMENT,
                status: "SUCCESS",
                deploymentStopped: false,
                snapshotId: SNAPSHOT,
              },
              activeDeployments: [{
                id: DEPLOYMENT,
                status: "SUCCESS",
                deploymentStopped: false,
              }],
              domains: {
                serviceDomains: [route(OTHER_ROUTE, collateralDomain)],
                customDomains: routePresent ? [route()] : [],
              },
            },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
}
function target(routePresent: boolean, replicas: 1 | 2 = 2) {
  return {
    data: {
      serviceInstance: {
        id: INSTANCE,
        serviceId: SERVICE,
        environmentId: PRODUCTION,
        numReplicas: replicas,
        latestDeployment: {
          id: DEPLOYMENT,
          status: "SUCCESS",
          deploymentStopped: false,
          snapshotId: SNAPSHOT,
        },
        activeDeployments: [{
          id: DEPLOYMENT,
          status: "SUCCESS",
          deploymentStopped: false,
        }],
        domains: {
          serviceDomains: [route(OTHER_ROUTE, "other.up.railway.app")],
          customDomains: routePresent ? [route()] : [],
        },
      },
      deployment: {
        id: DEPLOYMENT,
        projectId: PROJECT,
        environmentId: PRODUCTION,
        serviceId: SERVICE,
        snapshotId: SNAPSHOT,
        meta: {
          commitHash: CANDIDATE,
          imageDigest: `sha256:${"b".repeat(64)}`,
          patchId: null,
        },
      },
    },
  };
}
function runtime(routeName: "/health" | "/startup" | "/ready") {
  const data: Record<string, unknown> = {
    service: "pint-path",
    status: routeName === "/health"
      ? "ok"
      : routeName === "/startup" ? "startup_ready" : "ready",
    deployment: {
      version: "0.1.0",
      commitSha: CANDIDATE,
      environment: "production",
      projectIdSha256: railwayDeploymentIdentityIdSha256("project", PROJECT),
      environmentIdSha256:
        railwayDeploymentIdentityIdSha256("environment", PRODUCTION),
      serviceIdSha256: railwayDeploymentIdentityIdSha256("service", SERVICE),
      deploymentIdSha256:
        railwayDeploymentIdentityIdSha256("deployment", DEPLOYMENT),
      replicaIdSha256: "c".repeat(64),
    },
  };
  if (routeName !== "/health") data.dependencies = {};
  return { ok: true, data };
}

function writePredecessorAuthority(
  root: string,
  operation: "close" | "open",
): {
  githubAuthority: string;
  deploymentReceipt: string | null;
  scaleReceipt: string | null;
  closeReceipt: string | null;
  promotionReceipt: string | null;
} {
  type CheckPolicy = {
    stage?: string;
    name: string;
    workflowPath: string;
    event: "push" | "workflow_dispatch";
  };
  type ArtifactPolicy = {
    stage?: string;
    name: string;
    producerCheck: string;
  };
  const policy = JSON.parse(fs.readFileSync(
    path.resolve(".github/release-required-checks.json"),
    "utf8",
  )) as {
    requiredChecks: Record<string, CheckPolicy[]>;
    requiredArtifacts: Record<string, ArtifactPolicy[]>;
  };
  const stageCount = operation === "close" ? 2 : 5;
  const checkPolicies = [
    ...policy.requiredChecks.base,
    ...policy.requiredChecks.staging,
    ...policy.requiredChecks.production.slice(0, stageCount),
  ];
  const artifactPolicies = [
    ...policy.requiredArtifacts.base,
    ...policy.requiredArtifacts.staging,
    ...policy.requiredArtifacts.production.slice(0, stageCount),
  ];
  const checks = checkPolicies.map((item, index) => ({
    ...(item.stage ? { stage: item.stage } : {}),
    name: item.name,
    runId: 100 + index,
    checkSuiteId: 1_000 + index,
    workflowId: 2_000 + index,
    workflowPath: item.workflowPath,
    event: item.event,
    runAttempt: 1,
    startedAt: new Date(Date.UTC(1970, 0, 1, 0, index, 0)).toISOString(),
    completedAt: new Date(Date.UTC(1970, 0, 1, 0, index, 30)).toISOString(),
  }));
  const artifacts = artifactPolicies.map((item, index) => {
    const producer = checks.find((check) => check.name === item.producerCheck)!;
    const name = item.name.replaceAll("{candidateSha}", CANDIDATE);
    return {
      ...(item.stage ? { stage: item.stage } : {}),
      artifactId: 3_000 + index,
      name,
      digest: `sha256:${sha256(name)}`,
      sizeBytes: 100 + index,
      runId: producer.runId,
      producerCheck: item.producerCheck,
    };
  });
  const productionChain = [
    "deploy", "scale", "close", "activation", "promotion-recovery",
  ]
    .slice(0, stageCount)
    .map((stage) => ({
      ...checks.find((check) => check.stage === stage)!,
      artifact: artifacts.find((artifact) => artifact.stage === stage)!,
    }));
  const authority = {
    schemaVersion: "pintpath-github-release-candidate-receipt/v4",
    repository: "blackmagic30/Beer",
    branch: "main",
    phase: operation,
    candidateSha: CANDIDATE,
    reviewedPullRequest: {
      number: 24,
      reviewedPrHeadSha: "e".repeat(40),
      mergeCommitSha: CANDIDATE,
      treeSha: "f".repeat(40),
      mergedAt: "1970-01-01T00:00:00.000Z",
      authorId: 1,
      mergedById: 2,
      approvingReviewIds: [3],
      approvingReviewerIds: [3],
      githubMergeExact: true,
      reviewedTreeExact: true,
      independentApprovalExact: true,
      linearHistoryExact: true,
    },
    policySha256: RELEASE_POLICY_SHA256,
    consumer: {
      runId: 9_999,
      workflowId: 8_888,
      workflowPath: `.github/workflows/${operation}-production-route.yml`,
      event: "workflow_dispatch",
      runAttempt: 1,
      runStartedAt: "1970-01-01T00:20:00.000Z",
    },
    checks,
    artifacts,
    productionChain,
    orderedProductionChainSha256: sha256(canonical(productionChain)),
    requiredChecksExact: true,
    requiredArtifactsExact: true,
    chronologyExact: true,
    currentConsumerExact: true,
  };
  const githubAuthority = path.join(root, "github-authority.json");
  fs.writeFileSync(githubAuthority, canonical(authority), { mode: 0o600 });
  const deploymentIdSha256 = railwayDeploymentIdentityIdSha256(
    "deployment",
    DEPLOYMENT,
  )!;
  const deploymentValue = {
    schemaVersion: "pintpath-railway-application-deployment-executor/v4",
    operation: "pintpath-railway-application-source-upload",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    target: "production",
    outcome: "deployed",
    candidateSha: CANDIDATE,
    startedAt: "1970-01-01T00:11:05.000Z",
    completedAt: "1970-01-01T00:11:20.000Z",
    writeAttempts: 1,
    acknowledgement: "received",
    previousDeploymentIdSha256: "1".repeat(64),
    deploymentIdSha256,
    intentSha256: "2".repeat(64),
    cliOutputSha256: "3".repeat(64),
    boundaryPreflightSha256: "4".repeat(64),
    boundaryPostflightSha256: "5".repeat(64),
    collateralSnapshotSha256s: { before: "6".repeat(64), after: "6".repeat(64) },
    replicaCounts: { before: 1, after: 1 },
    runtimeResponseSha256s: {
      health: "7".repeat(64),
      startup: "8".repeat(64),
      ready: "9".repeat(64),
    },
    checks: {
      policyExact: true,
      githubMainExact: true,
      sourceAuthorityExact: true,
      cliExact: true,
      writeTokenScopeExact: true,
      costPolicyExact: true,
      prerequisiteExact: true,
      boundaryPreflightExact: true,
      targetPreflightExact: true,
      gitAutodeployAbsent: true,
      collateralInventoryExact: true,
      durableIntentExact: true,
      sourceReasserted: true,
      writeAttemptedAtMostOnce: true,
      targetPostflightAttempted: true,
      targetPostflightExact: true,
      reconciliationCompleted: true,
      topologyPreserved: true,
      deploymentExact: true,
      runtimeHealthExact: true,
      runtimeStartupExact: true,
      runtimeReadinessExact: true,
      collateralStateUnchanged: true,
      boundaryPostflightExact: true,
      terminalEvidenceExact: true,
    },
  };
  const deploymentReceipt = path.join(root, "deployment-receipt.json");
  fs.writeFileSync(deploymentReceipt, canonical(deploymentValue), { mode: 0o600 });
  const scaleValue = {
    schemaVersion: "pintpath-permanent-staging-scale-operation/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    direction: "converge-production-two",
    outcome: "scaled",
    candidateSha: CANDIDATE,
    startedAt: "1970-01-01T00:12:05.000Z",
    completedAt: "1970-01-01T00:12:20.000Z",
    desiredReplicas: 2,
    deploymentIdSha256,
    attempts: 1,
    retryAllowed: false,
    intentSha256: "a".repeat(64),
    terminalEvidenceSha256: "b".repeat(64),
    commandStdoutSha256: "c".repeat(64),
    commandStderrSha256: "d".repeat(64),
    checks: {
      policyExact: true,
      githubAuthorityExact: true,
      tokenScopesExact: true,
      cliExact: true,
      boundaryPreflightExact: true,
      targetPreflightExact: true,
      durableIntentExact: true,
      repositoryPrewriteReasserted: true,
      writeAttemptedAtMostOnce: true,
      acknowledgementExact: true,
      postflightAttempted: true,
      targetPostflightExact: true,
      candidateUnchanged: true,
      deploymentUnchanged: true,
      boundaryPostflightExact: true,
      terminalEvidenceExact: true,
      finalReceiptEvidenceExact: true,
    },
  };
  const scaleReceipt = path.join(root, "scale-receipt.json");
  fs.writeFileSync(scaleReceipt, canonical(scaleValue), { mode: 0o600 });
  if (operation === "close") {
    return {
      githubAuthority,
      deploymentReceipt,
      scaleReceipt,
      closeReceipt: null,
      promotionReceipt: null,
    };
  }
  const closeValue = {
    schemaVersion: "pintpath-protected-production-route-mutation/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    outcome: "closed",
    operation: "close",
    candidateSha: CANDIDATE,
    startedAt: "1970-01-01T00:13:05.000Z",
    completedAt: "1970-01-01T00:13:20.000Z",
    githubEnvironment: "production-route-close",
    policySha256: ROUTE_POLICY_SHA256,
    projectIdSha256: sha256(PROJECT),
    environmentIdSha256: sha256(PRODUCTION),
    serviceIdSha256: sha256(SERVICE),
    domain: "pintpath.au",
    targetPort: null,
    routeIdSha256: sha256(CUSTOM_ROUTE),
    deploymentIdSha256,
    predecessorAuthoritySha256: "e".repeat(64),
    orderedProductionChainSha256: sha256(canonical(productionChain.slice(0, 2))),
    productionDeploymentArtifactDigest:
      productionChain.find((stage) => stage.stage === "deploy")!.artifact.digest,
    productionScaleArtifactDigest:
      productionChain.find((stage) => stage.stage === "scale")!.artifact.digest,
    closedRouteArtifactDigest: null,
    promotionRecoveryArtifactDigest: null,
    promotionRecoveryReceiptSha256: null,
    productionDeploymentReceiptSha256: sha256(canonical(deploymentValue)),
    productionScaleReceiptSha256: sha256(canonical(scaleValue)),
    closedRouteReceiptSha256: null,
    attempts: 1,
    retryAllowed: false,
    intentSha256: "1".repeat(64),
    terminalEvidenceSha256: "2".repeat(64),
    beforeInventorySha256: "3".repeat(64),
    afterInventorySha256: "4".repeat(64),
    checks: {
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
    },
  };
  const closeReceipt = path.join(root, "close-receipt.json");
  const closeSource = canonical(closeValue);
  fs.writeFileSync(closeReceipt, closeSource, { mode: 0o600 });
  const promotion = buildProductionPromotionRecoveryReceipt({
    schemaVersion: "pintpath-production-promotion-recovery-receipt/v1",
    outcome: "verified",
    candidateSha: CANDIDATE,
    githubEnvironment: "production-promotion-recovery",
    policySha256: PROMOTION_RECOVERY_POLICY_SHA256,
    authorityManifestSha256: "2".repeat(64),
    activationReceiptSha256: "3".repeat(64),
    activationGithubAuthoritySha256: "4".repeat(64),
    activationProducerWorkflow: "activate-production-promotion-recovery.yml",
    activationProducerRunId: String(
      productionChain.find((stage) => stage.stage === "activation")!.runId,
    ),
    activationProducerRunAttempt: 1,
    activationRepository: "blackmagic30/Beer",
    activationArtifactName:
      productionChain.find((stage) => stage.stage === "activation")!.artifact.name,
    activationArtifactId: String(
      productionChain.find((stage) => stage.stage === "activation")!.artifact.artifactId,
    ),
    activationArtifactDigest:
      productionChain.find((stage) => stage.stage === "activation")!.artifact.digest,
    activationArtifactSizeBytes:
      productionChain.find((stage) => stage.stage === "activation")!.artifact.sizeBytes,
    activationTargetProjectIdSha256: "5".repeat(64),
    activationTargetEnvironmentIdSha256: "6".repeat(64),
    activationTargetSupabaseOriginSha256: "7".repeat(64),
    privateStorageWormReceiptSha256: "8".repeat(64),
    privateStorageWormRetrievalReceiptSha256: "9".repeat(64),
    recoveredApplicationReceiptSha256: "a".repeat(64),
    storagePurgeReceiptSha256: "b".repeat(64),
    railwayTeardownTerminalSha256: "c".repeat(64),
    supabaseTeardownTerminalSha256: "d".repeat(64),
    activationEvidenceAggregateSha256: "e".repeat(64),
    cleanupEvidenceAggregateSha256: "f".repeat(64),
    productionDeploymentReceiptSha256: sha256(canonical(deploymentValue)),
    productionDeploymentIdSha256: deploymentIdSha256,
    productionScaleReceiptSha256: sha256(canonical(scaleValue)),
    closedRouteReceiptSha256: sha256(closeSource),
    closedRouteTerminalEvidenceSha256: closeValue.terminalEvidenceSha256,
    applyAuthorizationReceiptSha256: "6".repeat(64),
    applyOperationReceiptSha256: "7".repeat(64),
    promotionOperationId: "66666666-6666-4666-8666-666666666666",
    promotionCommittedAt: "1970-01-01T00:13:45.000Z",
    quarantineReceiptSha256: null,
    pitrReceiptSha256: "8".repeat(64),
    pitrObservedAt: "1970-01-01T00:12:01.000Z",
    logicalBackupManifestSha256: "9".repeat(64),
    logicalBackupCreatedAt: "1970-01-01T00:12:02.000Z",
    offsiteSuccessStateSha256: "a".repeat(64),
    offsiteCompletedAt: "1970-01-01T00:12:03.000Z",
    wormReceiptSha256: "b".repeat(64),
    wormCompletedAt: "1970-01-01T00:12:04.000Z",
    logicalWormRetrievalReceiptSha256: "7".repeat(64),
    logicalWormRetrievedAt: "1970-01-01T00:12:06.500Z",
    privateStorageCaptureReceiptSha256: "c".repeat(64),
    privateStorageCapturedAt: "1970-01-01T00:12:05.000Z",
    offsiteRetrievalReceiptSha256: "d".repeat(64),
    offsiteRetrievedAt: "1970-01-01T00:12:06.000Z",
    logicalRestoreReceiptSha256: "e".repeat(64),
    logicalRestoreRestoredAt: "1970-01-01T00:12:07.000Z",
    privateStorageRestoreReceiptSha256: "f".repeat(64),
    privateStorageRestoredAt: "1970-01-01T00:12:08.000Z",
    deletionReplayFirstReceiptSha256: "0".repeat(64),
    deletionReplaySecondReceiptSha256: "1".repeat(64),
    deletionReplayCompletedAt: "1970-01-01T00:12:09.000Z",
    recoveryStartedAt: "1970-01-01T00:12:06.000Z",
    applicationReadyAt: "1970-01-01T00:12:10.000Z",
    recoveredApplicationCompletedAt: "1970-01-01T00:12:11.000Z",
    cleanupStartedAt: "1970-01-01T00:12:11.000Z",
    cleanupCompletedAt: "1970-01-01T00:12:12.000Z",
    recoveryTargetIdentitySha256: "2".repeat(64),
    recoveryPointAt: "1970-01-01T00:12:00.000Z",
    rpoSeconds: 1,
    rtoSeconds: 1,
    cleanupSeconds: 1,
    reviewerApprovalSetSha256: "3".repeat(64),
    reviewerIdSha256s: ["4".repeat(64), "5".repeat(64)],
    attestedAt: "1970-01-01T00:15:15.000Z",
    chronologySha256: "6".repeat(64),
    checks: {
      authorityExact: true,
      candidateExact: true,
      productionDeploymentExact: true,
      productionScaleExact: true,
      closedRouteExact: true,
      promotionAuthorizationExact: true,
      promotionApplyExact: true,
      quarantineAbsent: true,
      pitrExact: true,
      logicalBackupExact: true,
      operationalOffsiteExact: true,
      wormIndependentReaderExact: true,
      privateStorageCaptureExact: true,
      offsiteRetrievalExact: true,
      disposableLogicalRestoreExact: true,
      disposablePrivateStorageRestoreExact: true,
      deletionReplayAppliedExact: true,
      deletionReplayIdempotentExact: true,
      transportAndRoleExact: true,
      recoveryStateBindingsExact: true,
      activationProducerExact: true,
      recoveredApplicationExact: true,
      teardownAbsentExact: true,
      rpoRtoExact: true,
      twoPersonApprovalExact: true,
      chronologyExact: true,
    },
  });
  const promotionReceipt = path.join(root, "production-promotion-recovery-receipt.json");
  fs.writeFileSync(promotionReceipt, canonical(promotion), { mode: 0o600 });
  return {
    githubAuthority,
    deploymentReceipt: null,
    scaleReceipt: null,
    closeReceipt,
    promotionReceipt,
  };
}

function harness(operation: "close" | "open", options: {
  lostAck?: boolean;
  prewriteDrift?: boolean;
  collateralDrift?: boolean;
  runtimeCandidateDrift?: boolean;
  duplicateCanonicalRoute?: boolean;
  providerPrewriteDrift?: boolean;
  providerReplicas?: 1 | 2;
  authorityExtraKey?: boolean;
  reviewedPullRequestDrift?: boolean;
  duplicateAuthorityStage?: boolean;
  promotionReceiptDrift?: boolean;
  promotionPolicyDrift?: boolean;
  promotionAttestationTimeDrift?: boolean;
} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(
    path.join(os.tmpdir(), "pintpath-production-route-test-"),
  ));
  temporaryRoots.push(root);
  const evidenceDir = path.join(root, "evidence");
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  const authority = writePredecessorAuthority(root, operation);
  if (options.authorityExtraKey) {
    const value = JSON.parse(fs.readFileSync(authority.githubAuthority, "utf8"));
    value.untrusted = true;
    fs.writeFileSync(authority.githubAuthority, canonical(value));
  }
  if (options.reviewedPullRequestDrift) {
    const value = JSON.parse(fs.readFileSync(authority.githubAuthority, "utf8"));
    value.reviewedPullRequest.reviewedTreeExact = false;
    fs.writeFileSync(authority.githubAuthority, canonical(value));
  }
  if (options.duplicateAuthorityStage) {
    const value = JSON.parse(fs.readFileSync(authority.githubAuthority, "utf8"));
    value.productionChain[1] = value.productionChain[0];
    value.orderedProductionChainSha256 = sha256(canonical(value.productionChain));
    fs.writeFileSync(authority.githubAuthority, canonical(value));
  }
  if (options.promotionReceiptDrift && authority.promotionReceipt) {
    const value = JSON.parse(fs.readFileSync(authority.promotionReceipt, "utf8"));
    value.productionDeploymentIdSha256 = "0".repeat(64);
    fs.writeFileSync(authority.promotionReceipt, canonical(value));
  }
  if ((options.promotionPolicyDrift || options.promotionAttestationTimeDrift)
    && authority.promotionReceipt) {
    const value = JSON.parse(fs.readFileSync(authority.promotionReceipt, "utf8"));
    const { receiptSha256: _receiptSha256, ...withoutHash } = value;
    if (options.promotionPolicyDrift) withoutHash.policySha256 = "0".repeat(64);
    if (options.promotionAttestationTimeDrift) {
      withoutHash.attestedAt = "1970-01-01T00:13:59.999Z";
    }
    fs.writeFileSync(
      authority.promotionReceipt,
      canonical(buildProductionPromotionRecoveryReceipt(withoutHash as any)),
    );
  }
  let routePresent = operation === "close";
  let mutated = false;
  let inventoryReads = 0;
  const calls: Array<{ operationName: string; variables: unknown; url: string }> = [];
  const output: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://pintpath.au/")) {
      const routeName = new URL(url).pathname as "/health" | "/startup" | "/ready";
      const value = runtime(routeName);
      if (options.runtimeCandidateDrift) {
        (value.data.deployment as { commitSha: string }).commitSha = "d".repeat(40);
      }
      return json(value);
    }
    const body = JSON.parse(String(init?.body)) as {
      operationName: string;
      variables: Record<string, unknown>;
    };
    calls.push({ operationName: body.operationName, variables: body.variables, url });
    if (body.operationName === "PintPathProductionRouteTokenScope") return json(scope());
    if (body.operationName === "PintPathProductionRouteEmptyPatch") return json(patchEmpty());
    if (body.operationName === "PintPathProductionRouteInventory") {
      inventoryReads += 1;
      const value = inventory(
        routePresent,
        (options.collateralDrift && mutated)
            || (options.providerPrewriteDrift && inventoryReads === 2)
          ? "collateral-drift.up.railway.app"
          : "other.up.railway.app",
        options.providerReplicas ?? 2,
      );
      if (options.duplicateCanonicalRoute && !mutated) {
        const domains = value.data.environment.serviceInstances.edges[0]!.node.domains;
        domains.serviceDomains[0]!.domain = "pintpath.au";
      }
      return json(value);
    }
    if (body.operationName === "PintPathProductionRouteTarget") {
      return json(target(routePresent, options.providerReplicas ?? 2));
    }
    if (body.operationName === "PintPathCloseProductionRoute") {
      mutated = true;
      routePresent = false;
      if (options.lostAck) throw new Error("lost_ack");
      return json({ data: { customDomainDelete: true } });
    }
    if (body.operationName === "PintPathOpenProductionRoute") {
      mutated = true;
      routePresent = true;
      if (options.lostAck) throw new Error("lost_ack");
      return json({
        data: {
          customDomainCreate: {
            id: CUSTOM_ROUTE,
            domain: "pintpath.au",
            environmentId: PRODUCTION,
            serviceId: SERVICE,
            projectId: PROJECT,
            targetPort: null,
          },
        },
      });
    }
    return new Response("", { status: 404 });
  });
  const exactRepository = {
    headSha: CANDIDATE,
    originMainSha: CANDIDATE,
    clean: true,
  };
  return {
    calls,
    evidenceDir,
    fetchImpl,
    output,
    overrides: {
      argv: [
        "--operation", operation,
        "--candidate-sha", CANDIDATE,
        "--evidence-dir", evidenceDir,
        "--github-authority", authority.githubAuthority,
        ...(authority.deploymentReceipt
          ? ["--deployment-receipt", authority.deploymentReceipt]
          : []),
        ...(authority.scaleReceipt
          ? ["--scale-receipt", authority.scaleReceipt]
          : []),
        ...(authority.closeReceipt
          ? ["--close-receipt", authority.closeReceipt]
          : []),
        ...(authority.promotionReceipt
          ? ["--promotion-recovery-receipt", authority.promotionReceipt]
          : []),
      ],
      cwd: process.cwd(),
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_WORKFLOW_REF:
          `blackmagic30/Beer/.github/workflows/${operation}-production-route.yml@refs/heads/main`,
        PINTPATH_PRODUCTION_ROUTE_AUTHORITY_OPERATION: operation,
        PINTPATH_PRODUCTION_ROUTE_CONFIRMATION:
          `${operation.toUpperCase()}_PINTPATH_PRODUCTION_ROUTE`,
        PINTPATH_RAILWAY_PRODUCTION_ROUTE_METADATA_TOKEN: "m".repeat(32),
        PINTPATH_RAILWAY_PRODUCTION_ROUTE_MUTATION_TOKEN: "w".repeat(32),
        PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN: "p".repeat(32),
        PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "s".repeat(32),
      },
      fetchImpl: fetchImpl as typeof fetch,
      repositoryState: vi.fn(() => exactRepository),
      reassertRepositoryState: vi.fn(() => options.prewriteDrift
        ? { ...exactRepository, originMainSha: "e".repeat(40) }
        : exactRepository),
      runBoundary: vi.fn(async () => true),
      now: vi.fn(() => Date.UTC(1970, 0, 1, 0, 21, 0)),
      sleep: vi.fn(async () => undefined),
      writeOutput: (source: string) => output.push(source),
    },
  };
}

function receipt(output: readonly string[]): Record<string, any> {
  return JSON.parse(output.at(-1) ?? "{}") as Record<string, any>;
}

describe("protected production canonical-route executor", () => {
  it("pins an active exact Railway custom-domain policy and separate protected workflows", () => {
    expect(PROTECTED_PRODUCTION_ROUTE_MUTATION_SCHEMA).toBe(
      "pintpath-protected-production-route-mutation/v1",
    );
    expect(PROTECTED_PRODUCTION_ROUTE_MUTATION_STATE).toBe(
      "GITHUB_ENVIRONMENT_PROTECTED",
    );
    expect(protectedProductionRouteMutationInternals.policyExact(process.cwd())).toBe(true);
    expect(PRODUCTION_ROUTE_CLOSE_MUTATION).toContain("customDomainDelete");
    expect(PRODUCTION_ROUTE_OPEN_MUTATION).toContain("customDomainCreate");
    for (const [filename, environment, confirmation] of [
      ["close-production-route.yml", "production-route-close", "CLOSE_PINTPATH_PRODUCTION_ROUTE"],
      ["open-production-route.yml", "production-route-open", "OPEN_PINTPATH_PRODUCTION_ROUTE"],
    ]) {
      const source = fs.readFileSync(path.resolve(".github/workflows", filename), "utf8");
      expect(source).toContain("workflow_dispatch:");
      expect(source).toContain(`environment: ${environment}`);
      expect(source).toContain("group: pintpath-production-rollout");
      expect(source).toContain("cancel-in-progress: false");
      expect(source).toContain("actions: read");
      expect(source).toContain("checks: read");
      expect(source).toContain(`test \"$CONFIRMATION\" = ${confirmation}`);
      expect(source).toContain('test "$RUN_ATTEMPT" = 1');
      expect(source.match(/git fetch --no-tags origin/g)).toHaveLength(2);
      expect(source).toContain("if: always()\n        env:\n          PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN");
      expect(source).toContain("if: always()\n        uses: actions/upload-artifact@");
      expect(source).not.toMatch(/pull_request:|push:|schedule:/);
    }
    expect(fs.readFileSync(path.resolve(
      ".github/workflows/deploy-production.yml",
    ), "utf8")).toContain("group: pintpath-production-rollout");
    expect(fs.readFileSync(path.resolve(
      ".github/workflows/production-converge-two-replicas.yml",
    ), "utf8")).toContain("group: pintpath-production-rollout");
    const closeWorkflow = fs.readFileSync(path.resolve(
      ".github/workflows/close-production-route.yml",
    ), "utf8");
    const openWorkflow = fs.readFileSync(path.resolve(
      ".github/workflows/open-production-route.yml",
    ), "utf8");
    expect(closeWorkflow).toContain("--phase close");
    expect(closeWorkflow).toContain("--stage deploy");
    expect(closeWorkflow).toContain("--stage scale");
    expect(closeWorkflow).toContain("--deployment-receipt");
    expect(closeWorkflow).toContain("--scale-receipt");
    expect(openWorkflow).toContain("--phase open");
    expect(openWorkflow).toContain("--stage close");
    expect(openWorkflow).toContain("--stage promotion-recovery");
    expect(openWorkflow).toContain("--close-receipt");
    expect(openWorkflow).toContain("--promotion-recovery-receipt");
  });

  it("closes only the canonical route after exact preflight and retains provider-only proof", async () => {
    const fixture = harness("close");
    await expect(runProtectedProductionRouteMutation(fixture.overrides)).resolves.toBe(0);
    const result = receipt(fixture.output);
    expect(result).toMatchObject({
      outcome: "closed",
      operation: "close",
      startedAt: "1970-01-01T00:21:00.000Z",
      completedAt: "1970-01-01T00:21:00.000Z",
      deploymentIdSha256:
        railwayDeploymentIdentityIdSha256("deployment", DEPLOYMENT),
      predecessorAuthoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      orderedProductionChainSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      productionDeploymentArtifactDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      productionScaleArtifactDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      productionDeploymentReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      productionScaleReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      attempts: 1,
      retryAllowed: false,
      checks: {
        repositoryPrewriteReasserted: true,
        acknowledgementExact: true,
        inventoryTransitionExact: true,
        candidateDeploymentPostflightExact: true,
        publicRuntimePostflightExact: false,
        terminalEvidenceExact: true,
        finalReceiptEvidenceExact: true,
      },
    });
    expect(JSON.parse(fs.readFileSync(path.join(fixture.evidenceDir, "receipt.json"), "utf8")))
      .toEqual(result);
    expect(fixture.calls.filter((call) => call.operationName === "PintPathCloseProductionRoute"))
      .toHaveLength(1);
    expect(fixture.fetchImpl.mock.calls.some(([url]) => String(url).startsWith("https://pintpath.au/")))
      .toBe(false);
  });

  it("opens only the canonical route and binds all three public TLS routes to the candidate", async () => {
    const fixture = harness("open");
    await expect(runProtectedProductionRouteMutation(fixture.overrides)).resolves.toBe(0);
    const result = receipt(fixture.output);
    expect(result).toMatchObject({
      outcome: "opened",
      operation: "open",
      productionDeploymentReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      productionScaleReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      closedRouteReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      promotionRecoveryReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      attempts: 1,
      checks: {
        predecessorAuthorityExact: true,
        promotionRecoveryAuthorityExact: true,
        acknowledgementExact: true,
        inventoryTransitionExact: true,
        candidateDeploymentPostflightExact: true,
        publicRuntimePostflightExact: true,
        terminalEvidenceExact: true,
      },
    });
    const mutation = fixture.calls.find((call) => call.operationName === "PintPathOpenProductionRoute");
    expect(mutation?.variables).toEqual({
      input: {
        domain: "pintpath.au",
        environmentId: PRODUCTION,
        projectId: PROJECT,
        serviceId: SERVICE,
        targetPort: null,
      },
    });
    expect(fixture.fetchImpl.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith("https://pintpath.au/"))).toEqual([
        "https://pintpath.au/health",
        "https://pintpath.au/startup",
        "https://pintpath.au/ready",
      ]);
  });

  it("accepts a lost acknowledgement only after exact read-only reconciliation", async () => {
    for (const operation of ["close", "open"] as const) {
      const fixture = harness(operation, { lostAck: true });
      const code = await runProtectedProductionRouteMutation(fixture.overrides);
      expect(code, `${operation}:${fixture.output.at(-1)}`).toBe(0);
      expect(receipt(fixture.output)).toMatchObject({
        outcome: `${operation === "close" ? "closed" : "opened"}_reconciled_after_lost_ack`,
        attempts: 1,
        retryAllowed: false,
        checks: {
          acknowledgementExact: false,
          inventoryTransitionExact: true,
          candidateDeploymentPostflightExact: true,
          terminalEvidenceExact: true,
        },
      });
    }
  });

  it("reasserts remote main after durable intent and before any write", async () => {
    const fixture = harness("close", { prewriteDrift: true });
    await expect(runProtectedProductionRouteMutation(fixture.overrides)).resolves.toBe(1);
    expect(receipt(fixture.output)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: { durableIntentExact: true, repositoryPrewriteReasserted: false },
    });
    expect(fixture.calls.some((call) => call.operationName === "PintPathCloseProductionRoute"))
      .toBe(false);
  });

  it("reasserts provider target bytes after intent and before the boundary/write", async () => {
    const fixture = harness("close", { providerPrewriteDrift: true });
    await expect(runProtectedProductionRouteMutation(fixture.overrides)).resolves.toBe(1);
    expect(receipt(fixture.output)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: {
        durableIntentExact: true,
        repositoryPrewriteReasserted: true,
        providerPrewriteReasserted: false,
        boundaryPreflightExact: false,
      },
    });
    expect(fixture.overrides.runBoundary).not.toHaveBeenCalled();
    expect(fixture.calls.some((call) => call.operationName === "PintPathCloseProductionRoute"))
      .toBe(false);
  });

  it("fails closed on duplicate/collateral routes and wrong-candidate public runtime", async () => {
    for (const fixture of [
      harness("close", { duplicateCanonicalRoute: true }),
      harness("close", { collateralDrift: true }),
      harness("open", { runtimeCandidateDrift: true }),
    ]) {
      await expect(runProtectedProductionRouteMutation(fixture.overrides)).resolves.toBe(1);
      expect(receipt(fixture.output).outcome).toMatch(/failed_before_attempt|mutation_uncertain/);
    }
  });

  it("requires exactly two healthy replicas and canonical predecessor authorities", async () => {
    for (const fixture of [
      harness("close", { providerReplicas: 1 }),
      harness("open", { providerReplicas: 1 }),
      harness("close", { authorityExtraKey: true }),
      harness("close", { reviewedPullRequestDrift: true }),
      harness("close", { duplicateAuthorityStage: true }),
      harness("open", { promotionReceiptDrift: true }),
      harness("open", { promotionPolicyDrift: true }),
      harness("open", { promotionAttestationTimeDrift: true }),
    ]) {
      await expect(runProtectedProductionRouteMutation(fixture.overrides)).resolves.toBe(1);
      expect(receipt(fixture.output)).toMatchObject({
        outcome: "failed_before_attempt",
        attempts: 0,
      });
      expect(fixture.calls.some((call) =>
        call.operationName === "PintPathCloseProductionRoute"
          || call.operationName === "PintPathOpenProductionRoute")).toBe(false);
    }
  });
});
