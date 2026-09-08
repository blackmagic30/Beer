import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  argumentsExact,
  authorityExact,
  canonical,
  COLD_RECOVERY_EXTERNAL_MUTATION_FREEZE_ATTESTATION,
  COLD_RECOVERY_LOCK,
  COLD_RECOVERY_POLICY_SHA256,
  COLD_QUIESCE_SUCCESSOR_BINDING,
  coldIdentityCanonical,
  defaultBoundaryCheck,
  fullStateCanonical,
  maintenanceRowsAfterExact,
  nonMaintenanceRows,
  parseColdQuiesceSuccessorBinding,
  policyExact,
  probeRuntimeAbsent,
  railwayCall,
  readColdRecoveryState,
  readPrivateEvidence,
  reassertRepositoryState,
  sha256,
  tokenScopeExact,
  tokensExact,
  writeDurable,
  COLD_RECOVERY_SCOPE_QUERY,
  type BoundaryEvidence,
  type ColdRecoveryState,
  type ColdQuiesceSuccessorBinding,
} from "./lib/permanent-staging-cold-recovery.js";
import {
  commitRailwayReplicaEnvironmentPatch,
  railwayEnvironmentPatchCommitVariables,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
  type RailwayEnvironmentPatchCommitAttempt,
} from "./lib/railway-environment-patch-commit.js";
import {
  parseStagingWorkerBootstrapPrerequisitesVerification,
} from "./verify-permanent-staging-worker-bootstrap-prerequisites.js";
import {
  patchHistoryEvidenceExact,
  protectedPermanentStagingScaleInternals,
  readPatchHistory,
  type ScalePatchHistoryEvidence,
} from "./execute-protected-permanent-staging-scale.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";

export const COLD_QUIESCE_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-cold-quiesce/v6" as const;

interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  externalMutationFreezeAttested: boolean;
  successorBridgeExact: boolean;
  successorBridgeTopologyExact: boolean;
  successorBridgePrewriteReasserted: boolean;
  preparePrerequisiteExact: boolean;
  tokenScopesExact: boolean;
  directMutationContractExact: boolean;
  boundaryPreflightExact: boolean;
  exactDeadStateBefore: boolean;
  maintenanceRowsBeforeExact: boolean;
  runtimeAbsentBefore: boolean;
  durableIntentExact: boolean;
  repositoryPrewriteReasserted: boolean;
  providerPrewriteReasserted: boolean;
  runtimePrewriteReasserted: boolean;
  providerHistoryPrewriteExact: boolean;
  writeAttemptedAtMostOnce: boolean;
  mutationResponseClassified: boolean;
  acknowledgementExact: boolean;
  lostAcknowledgementExact: boolean;
  providerHistoryPostflightExact: boolean;
  postflightAttempted: boolean;
  exactZeroStateAfter: boolean;
  configuredTopologyTransitionExact: boolean;
  maintenanceRowsAfterExact: boolean;
  deploymentSourceAndTopologyUnchanged: boolean;
  collateralVariablesUnchanged: boolean;
  runtimeAbsentAfter: boolean;
  boundaryPostflightExact: boolean;
  terminalEvidenceExact: boolean;
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly boundaryCheck: () => Promise<BoundaryEvidence>;
  readonly readState: (
    configuredReplicas: 0 | 1 | "any",
  ) => Promise<ColdRecoveryState | null>;
  readonly readPrivateEvidence: (filename: string) => string;
  readonly reassertRepositoryState: (cwd: string, candidateSha: string) => boolean;
  readonly probeRuntimeAbsent: () => Promise<boolean>;
  readonly commitScale: (
    token: string,
    candidateSha: string,
    runId: string,
  ) => Promise<RailwayEnvironmentPatchCommitAttempt>;
  readonly readPatchHistory: (
    token: string,
    environmentId: string,
    commitMessage: string,
    expectedPatch: unknown,
  ) => Promise<ScalePatchHistoryEvidence>;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

function emptyChecks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    externalMutationFreezeAttested: false,
    successorBridgeExact: false,
    successorBridgeTopologyExact: false,
    successorBridgePrewriteReasserted: false,
    preparePrerequisiteExact: false,
    tokenScopesExact: false,
    directMutationContractExact: false,
    boundaryPreflightExact: false,
    exactDeadStateBefore: false,
    maintenanceRowsBeforeExact: false,
    runtimeAbsentBefore: false,
    durableIntentExact: false,
    repositoryPrewriteReasserted: false,
    providerPrewriteReasserted: false,
    runtimePrewriteReasserted: false,
    providerHistoryPrewriteExact: false,
    writeAttemptedAtMostOnce: true,
    mutationResponseClassified: false,
    acknowledgementExact: false,
    lostAcknowledgementExact: false,
    providerHistoryPostflightExact: false,
    postflightAttempted: false,
    exactZeroStateAfter: false,
    configuredTopologyTransitionExact: false,
    maintenanceRowsAfterExact: false,
    deploymentSourceAndTopologyUnchanged: false,
    collateralVariablesUnchanged: false,
    runtimeAbsentAfter: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
  };
}

function successfulChecks(
  value: Checks,
  outcome: "configured_zero" | "reconciled_configured_zero" |
    "failed_before_attempt" | "mutation_uncertain",
): boolean {
  const common = Object.entries(value).filter(
    ([name]) =>
      name !== "acknowledgementExact" && name !== "lostAcknowledgementExact",
  ).every(([, check]) => check === true);
  return common && ((outcome === "configured_zero" && value.acknowledgementExact) ||
    (outcome === "reconciled_configured_zero" &&
      !value.acknowledgementExact && value.lostAcknowledgementExact));
}

export function coldQuiesceCommitMessage(
  candidateSha: string,
  runId: string,
): string {
  return `PintPath cold quiesce ${candidateSha} run ${runId}`;
}

async function reconcile(dependencies: Dependencies): Promise<ColdRecoveryState | null> {
  const deadline = dependencies.now() + 60_000;
  do {
    const state = await dependencies.readState(0);
    if (state && maintenanceRowsAfterExact(state.rows)) return state;
    if (dependencies.now() >= deadline) break;
    await dependencies.sleep(5_000);
  } while (dependencies.now() <= deadline);
  return null;
}

export async function runProtectedPermanentStagingColdQuiesce(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  let dependencies = null as unknown as Dependencies;
  dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    boundaryCheck: () => defaultBoundaryCheck(dependencies.env, dependencies.fetchImpl),
    readState: (replicas) => readColdRecoveryState(
      dependencies.fetchImpl,
      dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "",
      replicas,
    ),
    readPrivateEvidence,
    reassertRepositoryState,
    probeRuntimeAbsent: () => probeRuntimeAbsent(
      dependencies.fetchImpl,
      dependencies.sleep,
    ),
    commitScale: (token, candidateSha, runId) =>
      commitRailwayReplicaEnvironmentPatch(
        dependencies.fetchImpl,
        token,
        {
          environmentId: COLD_RECOVERY_LOCK.environmentId,
          serviceId: COLD_RECOVERY_LOCK.serviceId,
          regions: COLD_RECOVERY_LOCK.quiesceRegions.map((region) => ({
            region,
            numReplicas: 0,
          })),
          commitMessage: coldQuiesceCommitMessage(candidateSha, runId),
        },
      ),
    readPatchHistory: (token, environmentId, commitMessage, expectedPatch) =>
      readPatchHistory(
        dependencies.fetchImpl,
        token,
        environmentId,
        commitMessage,
        expectedPatch,
      ),
    writeDurable,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };

  const startedAt = new Date(dependencies.now()).toISOString();
  const resultChecks = emptyChecks();
  const args = argumentsExact(dependencies.argv, true);
  let before: ColdRecoveryState | null = null;
  let after: ColdRecoveryState | null = null;
  let attempts: 0 | 1 = 0;
  let intentSha256: string | null = null;
  let terminalSha256: string | null = null;
  let prerequisiteSha256: string | null = null;
  let successorBridge: ColdQuiesceSuccessorBinding | null = null;
  let failureCode: string | null = null;
  let outcome: "configured_zero" | "reconciled_configured_zero" |
    "failed_before_attempt" | "mutation_uncertain" = "failed_before_attempt";
  let boundaryBefore: BoundaryEvidence = { passed: false, receiptSha256: null };
  let boundaryAfter: BoundaryEvidence = { passed: false, receiptSha256: null };
  let mutationAttempt: RailwayEnvironmentPatchCommitAttempt | null = null;
  let mutationVariables: Record<string, unknown> | null = null;
  let providerHistoryPrewrite: ScalePatchHistoryEvidence | null = null;
  let providerHistoryPostflight: ScalePatchHistoryEvidence | null = null;
  let tokens: ReturnType<typeof tokensExact> = null;
  let completedAt = startedAt;

  try {
    resultChecks.policyExact = policyExact(dependencies.cwd);
    if (!args || !resultChecks.policyExact) throw new Error("policy_or_arguments_invalid");
    resultChecks.githubAuthorityExact = authorityExact(
      dependencies.env,
      "quiesce",
      args.candidateSha,
      args.expectedDeploymentSha,
    );
    if (!resultChecks.githubAuthorityExact) throw new Error("authority_invalid");
    resultChecks.externalMutationFreezeAttested =
      dependencies.env.PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION ===
        COLD_RECOVERY_EXTERNAL_MUTATION_FREEZE_ATTESTATION;
    if (!resultChecks.externalMutationFreezeAttested) {
      throw new Error("external_mutation_freeze_invalid");
    }
    const successorBridgeSource = dependencies.readPrivateEvidence(
      args.successorBridgeFile!,
    );
    const reviewedAuthoritySource = dependencies.readPrivateEvidence(
      args.reviewedAuthorityFile!,
    );
    successorBridge = parseColdQuiesceSuccessorBinding(
      successorBridgeSource,
      reviewedAuthoritySource,
      args.candidateSha,
      dependencies.env.GITHUB_RUN_ID ?? "",
      args.prepareRunId!,
      dependencies.now(),
    );
    resultChecks.successorBridgeExact = successorBridge !== null;
    if (!resultChecks.successorBridgeExact) {
      throw new Error("successor_bridge_invalid");
    }
    const prerequisiteSource = dependencies.readPrivateEvidence(
      args.prepareVerificationFile!,
    );
    const prerequisite = parseStagingWorkerBootstrapPrerequisitesVerification(
      prerequisiteSource,
      {
        operation: "cold-quiesce",
        bootstrapPath: "cold-dead",
        candidateSha: args.candidateSha,
        currentRunId: dependencies.env.GITHUB_RUN_ID ?? "",
        now: new Date(dependencies.now()),
      },
    );
    prerequisiteSha256 = sha256(prerequisiteSource);
    resultChecks.preparePrerequisiteExact = prerequisite.expectedDeploymentSha ===
      args.expectedDeploymentSha && prerequisite.prerequisites.length === 1 &&
      prerequisite.prerequisites[0]?.kind === "cold-prepare" &&
      prerequisite.prerequisites[0]?.runId === args.prepareRunId &&
      prerequisite.prerequisites[0]?.receipt.replicasBefore === 1 &&
      prerequisite.prerequisites[0]?.receipt.replicasAfter === 1;
    if (!resultChecks.preparePrerequisiteExact) throw new Error("prepare_invalid");
    tokens = tokensExact(dependencies.env, "quiesce");
    if (!tokens) throw new Error("token_invalid");
    const [metadataScope, scaleScope] = await Promise.all([
      railwayCall(dependencies.fetchImpl, tokens.metadata, COLD_RECOVERY_SCOPE_QUERY, {}),
      railwayCall(dependencies.fetchImpl, tokens.mutation, COLD_RECOVERY_SCOPE_QUERY, {}),
    ]);
    resultChecks.tokenScopesExact = tokenScopeExact(metadataScope) &&
      tokenScopeExact(scaleScope);
    if (!resultChecks.tokenScopesExact) throw new Error("token_scope_invalid");
    const currentRunId = dependencies.env.GITHUB_RUN_ID ?? "";
    const exactMutationVariables = railwayEnvironmentPatchCommitVariables({
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      regions: COLD_RECOVERY_LOCK.quiesceRegions.map((region) => ({
        region,
        numReplicas: 0,
      })),
      commitMessage: coldQuiesceCommitMessage(args.candidateSha, currentRunId),
    });
    if (exactMutationVariables === null) {
      throw new Error("direct_mutation_contract_invalid");
    }
    mutationVariables = exactMutationVariables;
    const expectedMutationVariables = {
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      patch: {
        services: {
          [COLD_RECOVERY_LOCK.serviceId]: {
            deploy: {
              multiRegionConfig: Object.fromEntries(
                [...COLD_RECOVERY_LOCK.quiesceRegions].sort().map((region) => [
                  region,
                  null,
                ]),
              ),
            },
          },
        },
      },
      commitMessage: coldQuiesceCommitMessage(args.candidateSha, currentRunId),
    };
    resultChecks.directMutationContractExact =
      RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION.includes(
        `mutation ${RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME}`,
      ) && RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION.includes(
        "environmentPatchCommit(",
      ) && canonical(exactMutationVariables) === canonical(expectedMutationVariables);
    if (!resultChecks.directMutationContractExact) {
      throw new Error("direct_mutation_contract_invalid");
    }
    boundaryBefore = await dependencies.boundaryCheck();
    resultChecks.boundaryPreflightExact = boundaryBefore.passed &&
      boundaryBefore.receiptSha256 !== null;
    if (!resultChecks.boundaryPreflightExact) throw new Error("boundary_invalid");
    before = await dependencies.readState(1);
    resultChecks.successorBridgeTopologyExact = before !== null &&
      successorBridge!.liveStateSha256 === sha256(fullStateCanonical(before));
    resultChecks.exactDeadStateBefore = before !== null &&
      resultChecks.successorBridgeTopologyExact;
    resultChecks.maintenanceRowsBeforeExact = before !== null &&
      maintenanceRowsAfterExact(before.rows);
    if (!resultChecks.exactDeadStateBefore || !resultChecks.maintenanceRowsBeforeExact) {
      throw new Error("dead_state_invalid");
    }
    resultChecks.runtimeAbsentBefore = await dependencies.probeRuntimeAbsent();
    if (!resultChecks.runtimeAbsentBefore) throw new Error("runtime_present");
    const intent = canonical({
      schemaVersion: "pintpath-permanent-staging-cold-quiesce-intent/v5",
      policySha256: COLD_RECOVERY_POLICY_SHA256,
      operation: "cold-quiesce",
      candidateSha: args.candidateSha,
      expectedDeploymentSha: args.expectedDeploymentSha,
      prepareRunId: args.prepareRunId,
      prepareVerificationSha256: prerequisiteSha256,
      successorBridge: {
        bridgeSha256: successorBridge!.bridgeSha256,
        reviewedAuthoritySha256: successorBridge!.reviewedAuthoritySha256,
        currentRunId: successorBridge!.currentRunId,
        currentPrepareRunId: successorBridge!.currentPrepareRunId,
        priorCandidateSha: successorBridge!.priorCandidateSha,
        priorQuiesceRunId: successorBridge!.priorQuiesceRunId,
        priorArtifactId: successorBridge!.priorArtifactId,
        priorArtifactDigest: successorBridge!.priorArtifactDigest,
        liveStateSha256: successorBridge!.liveStateSha256,
        verifiedAt: successorBridge!.verifiedAt,
        deadline: COLD_QUIESCE_SUCCESSOR_BINDING.deadline,
      },
      projectId: COLD_RECOVERY_LOCK.projectId,
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      deploymentIdSha256: railwayDeploymentIdentityIdSha256(
        "deployment",
        COLD_RECOVERY_LOCK.deploymentId,
      ),
      configuredReplicasBefore: before!.configuredReplicas,
      configuredReplicasAfter: 0,
      configuredRegionsBefore: before!.configuredRegions,
      configuredRegionsAfter: COLD_RECOVERY_LOCK.quiesceRegions.map((region) => ({
        region,
        numReplicas: 0,
      })),
      legacyReplicasBefore: before!.numReplicas,
      legacyReplicasAfterAllowed: [null, 0],
      providerBeforeSha256: sha256(fullStateCanonical(before!)),
      boundaryPreflightReceiptSha256: boundaryBefore.receiptSha256,
      maximumAttempts: 1,
      retryAllowed: false,
      mutation: {
        operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
        operation: "environmentPatchCommit",
        querySha256: sha256(RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION),
        variablesSha256: sha256(JSON.stringify(exactMutationVariables)),
        commitMessageSha256: sha256(
          coldQuiesceCommitMessage(args.candidateSha, currentRunId),
        ),
        zeroRegionsEncodedAsJsonNull: true,
        providerHistoryPrewriteMatchingPatchCount: 0,
        providerHistoryContinuityRequired: true,
        providerPatchCrossFetchRequired: true,
        providerCasOrLockVerified: false,
        externalMutationFreezeEnforcement: "operational_attestation_only",
      },
      configuredOneToZeroReceiptClaimed: true,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    intentSha256 = dependencies.writeDurable(
      args.evidenceDirectory,
      "cold-quiesce-intent.json",
      intent,
    );
    resultChecks.durableIntentExact = intentSha256 === sha256(intent);
    if (!resultChecks.durableIntentExact) throw new Error("intent_invalid");
    resultChecks.repositoryPrewriteReasserted = dependencies.reassertRepositoryState(
      dependencies.cwd,
      args.candidateSha,
    );
    if (!resultChecks.repositoryPrewriteReasserted) throw new Error("repository_drift");
    const exactBefore = before!;
    resultChecks.runtimePrewriteReasserted = await dependencies.probeRuntimeAbsent();
    if (!resultChecks.runtimePrewriteReasserted) throw new Error("runtime_present");
    const reboundBridgeSource = dependencies.readPrivateEvidence(
      args.successorBridgeFile!,
    );
    const reboundAuthoritySource = dependencies.readPrivateEvidence(
      args.reviewedAuthorityFile!,
    );
    const reboundBridge = parseColdQuiesceSuccessorBinding(
      reboundBridgeSource,
      reboundAuthoritySource,
      args.candidateSha,
      dependencies.env.GITHUB_RUN_ID ?? "",
      args.prepareRunId!,
      dependencies.now(),
    );
    resultChecks.successorBridgePrewriteReasserted = reboundBridge !== null &&
      reboundBridge.bridgeSha256 === successorBridge!.bridgeSha256 &&
      reboundBridge.reviewedAuthoritySha256 ===
        successorBridge!.reviewedAuthoritySha256 &&
      reboundBridge.liveStateSha256 === sha256(fullStateCanonical(exactBefore));
    if (!resultChecks.successorBridgePrewriteReasserted) {
      throw new Error("successor_bridge_expired_or_drifted");
    }
    providerHistoryPrewrite = await dependencies.readPatchHistory(
      tokens.metadata,
      COLD_RECOVERY_LOCK.environmentId,
      coldQuiesceCommitMessage(args.candidateSha, currentRunId),
      exactMutationVariables.patch,
    );
    resultChecks.providerHistoryPrewriteExact = patchHistoryEvidenceExact(
      providerHistoryPrewrite,
      0,
      coldQuiesceCommitMessage(args.candidateSha, currentRunId),
      exactMutationVariables.patch,
    );
    if (!resultChecks.providerHistoryPrewriteExact) {
      throw new Error("provider_patch_history_prewrite_invalid");
    }

    // This is intentionally the final awaited provider/state operation before
    // the sole mutation call. All runtime, repository, bridge, and ledger work
    // above must settle before this exact state is reasserted.
    const prewrite = await dependencies.readState(1);
    resultChecks.providerPrewriteReasserted = prewrite !== null &&
      fullStateCanonical(prewrite) === fullStateCanonical(exactBefore) &&
      reboundBridge!.liveStateSha256 === sha256(fullStateCanonical(prewrite));
    if (!resultChecks.providerPrewriteReasserted) throw new Error("provider_drift");

    // Re-read and reparse the private authority synchronously after the final
    // provider state await. This prevents a near-deadline ledger traversal or
    // late local evidence substitution from extending the write authority.
    const finalBridgeSource = dependencies.readPrivateEvidence(
      args.successorBridgeFile!,
    );
    const finalAuthoritySource = dependencies.readPrivateEvidence(
      args.reviewedAuthorityFile!,
    );
    const finalBridge = parseColdQuiesceSuccessorBinding(
      finalBridgeSource,
      finalAuthoritySource,
      args.candidateSha,
      currentRunId,
      args.prepareRunId!,
      dependencies.now(),
    );
    resultChecks.successorBridgePrewriteReasserted = finalBridge !== null &&
      finalBridge.bridgeSha256 === successorBridge!.bridgeSha256 &&
      finalBridge.reviewedAuthoritySha256 ===
        successorBridge!.reviewedAuthoritySha256 &&
      finalBridge.liveStateSha256 === sha256(fullStateCanonical(prewrite!));
    if (!resultChecks.successorBridgePrewriteReasserted) {
      throw new Error("successor_bridge_expired_or_drifted");
    }

    attempts = 1;
    try {
      mutationAttempt = await dependencies.commitScale(
        tokens.mutation,
        args.candidateSha,
        currentRunId,
      );
    } catch {
      mutationAttempt = null;
    }
    resultChecks.mutationResponseClassified = mutationAttempt !== null &&
      protectedPermanentStagingScaleInternals.mutationAttemptEvidenceExact(
        mutationAttempt,
        exactMutationVariables,
      );
    resultChecks.acknowledgementExact =
      resultChecks.mutationResponseClassified &&
      mutationAttempt?.outcome === "acknowledged" &&
      mutationAttempt.acknowledgementExact;
    resultChecks.lostAcknowledgementExact =
      resultChecks.mutationResponseClassified &&
      mutationAttempt?.outcome === "transport_uncertain" &&
      !mutationAttempt.acknowledgementExact;
  } catch (error) {
    failureCode = error instanceof Error ? error.message : "unexpected_failure";
  } finally {
    if (before !== null && attempts === 1) {
      resultChecks.postflightAttempted = true;
      try { after = await reconcile(dependencies); } catch { after = null; }
      resultChecks.exactZeroStateAfter = after !== null;
      resultChecks.configuredTopologyTransitionExact = after !== null &&
        after.configuredReplicas === 0 &&
        before.configuredReplicas === 1 &&
        after.configuredRegions.every((entry) => entry.numReplicas === 0);
      resultChecks.maintenanceRowsAfterExact = after !== null &&
        maintenanceRowsAfterExact(after.rows);
      resultChecks.deploymentSourceAndTopologyUnchanged = after !== null &&
        coldIdentityCanonical(after) === coldIdentityCanonical(before) &&
        before.deploymentRegions.length === after.deploymentRegions.length;
      resultChecks.collateralVariablesUnchanged = after !== null &&
        canonical(nonMaintenanceRows(after.rows)) ===
          canonical(nonMaintenanceRows(before.rows));
      try {
        providerHistoryPostflight = await dependencies.readPatchHistory(
          tokens!.metadata,
          COLD_RECOVERY_LOCK.environmentId,
          coldQuiesceCommitMessage(
            args!.candidateSha,
            dependencies.env.GITHUB_RUN_ID ?? "",
          ),
          mutationVariables!.patch,
        );
      } catch {
        providerHistoryPostflight = null;
      }
      try { resultChecks.runtimeAbsentAfter = await dependencies.probeRuntimeAbsent(); } catch {
        resultChecks.runtimeAbsentAfter = false;
      }
      try { boundaryAfter = await dependencies.boundaryCheck(); } catch {
        boundaryAfter = { passed: false, receiptSha256: null };
      }
      resultChecks.boundaryPostflightExact = boundaryAfter.passed &&
        boundaryAfter.receiptSha256 !== null;
      completedAt = new Date(dependencies.now()).toISOString();
      resultChecks.providerHistoryPostflightExact =
        providerHistoryPostflight !== null &&
        providerHistoryPrewrite !== null &&
        patchHistoryEvidenceExact(
          providerHistoryPostflight,
          1,
          coldQuiesceCommitMessage(
            args!.candidateSha,
            dependencies.env.GITHUB_RUN_ID ?? "",
          ),
          mutationVariables!.patch,
          {
            startedAtMs: Date.parse(startedAt),
            completedAtMs: Date.parse(completedAt),
          },
        ) &&
        providerHistoryPostflight.rowCount ===
          providerHistoryPrewrite.rowCount + 1 &&
        providerHistoryPostflight.nonMatchingRowsProjectionSha256 ===
          providerHistoryPrewrite.rowsProjectionSha256;
      const successfulWithoutTerminalOrAcknowledgement = Object.entries(resultChecks)
        .filter(([name]) =>
          name !== "terminalEvidenceExact" && name !== "acknowledgementExact" &&
          name !== "lostAcknowledgementExact")
        .every(([, value]) => value === true);
      if (successfulWithoutTerminalOrAcknowledgement) {
        if (resultChecks.acknowledgementExact) {
          failureCode = null;
          outcome = "configured_zero";
        } else if (resultChecks.lostAcknowledgementExact) {
          failureCode = null;
          outcome = "reconciled_configured_zero";
        } else {
          failureCode ??= "provider_rejected_without_acknowledgement";
          outcome = "mutation_uncertain";
        }
      } else {
        failureCode ??= "reconciliation_failed";
        outcome = "mutation_uncertain";
      }
    }
  }

  if (attempts === 1 && args && before) {
    const receipt = canonical({
      schemaVersion: COLD_QUIESCE_RECEIPT_SCHEMA,
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      operation: "cold-quiesce",
      target: "permanent-staging",
      outcome,
      failureCode,
      candidateSha: args.candidateSha,
      sourceSha: args.expectedDeploymentSha,
      startedAt,
      completedAt,
      configuredReplicasBefore: before.configuredReplicas,
      configuredReplicasAfter: after?.configuredReplicas ?? null,
      configuredRegionsBefore: before.configuredRegions,
      configuredRegionsAfter: after?.configuredRegions ?? null,
      legacyReplicasBefore: before.numReplicas,
      legacyReplicasAfter: after?.numReplicas ?? null,
      attempts,
      retryAllowed: false,
      intentSha256,
      preparePrerequisite: {
        runId: args.prepareRunId,
        verificationSha256: prerequisiteSha256,
      },
      successorBridge: successorBridge === null
        ? null
        : {
          bridgeSha256: successorBridge.bridgeSha256,
          reviewedAuthoritySha256: successorBridge.reviewedAuthoritySha256,
          currentRunId: successorBridge.currentRunId,
          currentPrepareRunId: successorBridge.currentPrepareRunId,
          priorCandidateSha: successorBridge.priorCandidateSha,
          priorQuiesceRunId: successorBridge.priorQuiesceRunId,
          priorArtifactId: successorBridge.priorArtifactId,
          priorArtifactDigest: successorBridge.priorArtifactDigest,
          liveStateSha256: successorBridge.liveStateSha256,
          verifiedAt: successorBridge.verifiedAt,
          deadline: COLD_QUIESCE_SUCCESSOR_BINDING.deadline,
        },
      runnerLossReconciliation: null,
      directMutationEvidence: {
        operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
        operation: "environmentPatchCommit",
        transportOutcome: mutationAttempt?.outcome ?? null,
        querySha256: mutationAttempt?.querySha256 ??
          sha256(RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION),
        variablesSha256: mutationAttempt?.variablesSha256 ??
          sha256(JSON.stringify(mutationVariables)),
        requestBodySha256: mutationAttempt?.requestBodySha256 ?? sha256(
          JSON.stringify({
            operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
            query: RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
            variables: mutationVariables,
          }),
        ),
        responseBodySha256: mutationAttempt?.responseBodySha256 ?? null,
        acknowledgementSha256:
          mutationAttempt?.acknowledgementSha256 ?? null,
        acknowledgementExact:
          mutationAttempt?.acknowledgementExact ?? false,
        commitMessageSha256: sha256(
          coldQuiesceCommitMessage(
            args.candidateSha,
            dependencies.env.GITHUB_RUN_ID ?? "",
          ),
        ),
        zeroRegionsEncodedAsJsonNull:
          mutationAttempt?.zeroRegionsEncodedAsJsonNull ??
          (mutationVariables !== null &&
            canonical(mutationVariables) === canonical({
              environmentId: COLD_RECOVERY_LOCK.environmentId,
              patch: {
                services: {
                  [COLD_RECOVERY_LOCK.serviceId]: {
                    deploy: {
                      multiRegionConfig: Object.fromEntries(
                        [...COLD_RECOVERY_LOCK.quiesceRegions].sort().map(
                          (region) => [region, null],
                        ),
                      ),
                    },
                  },
                },
              },
              commitMessage: coldQuiesceCommitMessage(
                args.candidateSha,
                dependencies.env.GITHUB_RUN_ID ?? "",
              ),
            })),
        providerCasOrLockVerified: false,
        externalMutationFreezeEnforcement: "operational_attestation_only",
      },
      providerHistoryEvidence: {
        prewrite: providerHistoryPrewrite,
        postflight: providerHistoryPostflight,
      },
      providerEvidence: {
        deploymentIdSha256: railwayDeploymentIdentityIdSha256(
          "deployment",
          COLD_RECOVERY_LOCK.deploymentId,
        ),
        snapshotIdSha256: sha256(COLD_RECOVERY_LOCK.snapshotId),
        stateBeforeSha256: sha256(fullStateCanonical(before)),
        stateAfterSha256: after ? sha256(fullStateCanonical(after)) : null,
        topologyBeforeSha256: sha256(coldIdentityCanonical(before)),
        topologyAfterSha256: after ? sha256(coldIdentityCanonical(after)) : null,
        configuredTopologyBeforeSha256: sha256(canonical(before.configuredRegions)),
        configuredTopologyAfterSha256: after
          ? sha256(canonical(after.configuredRegions))
          : null,
        collateralVariablesBeforeSha256: sha256(canonical(nonMaintenanceRows(before.rows))),
        collateralVariablesAfterSha256: after
          ? sha256(canonical(nonMaintenanceRows(after.rows)))
          : null,
        sourceDisconnectedBefore: true,
        sourceDisconnectedAfter: after !== null,
        stagedPatchEmptyBefore: true,
        stagedPatchEmptyAfter: after !== null,
      },
      mutationBoundaryEvidence: {
        preflightReceiptSha256: boundaryBefore.receiptSha256,
        postflightReceiptSha256: boundaryAfter.receiptSha256,
      },
      checks: { ...resultChecks, terminalEvidenceExact: true },
      nextRequiredProof: "EXACT_CANDIDATE_UPLOAD_AT_CONFIGURED_ZERO",
      configuredOneToZeroReceiptClaimed:
        (outcome === "configured_zero" ||
          outcome === "reconciled_configured_zero") &&
        resultChecks.exactZeroStateAfter &&
        resultChecks.configuredTopologyTransitionExact,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    try {
      terminalSha256 = dependencies.writeDurable(
        args.evidenceDirectory,
        "cold-quiesce-receipt.json",
        receipt,
      );
      resultChecks.terminalEvidenceExact = terminalSha256 === sha256(receipt);
    } catch {
      resultChecks.terminalEvidenceExact = false;
    }
    if (!resultChecks.terminalEvidenceExact) {
      outcome = "mutation_uncertain";
      failureCode ??= "terminal_evidence_failed";
    }
  }

  dependencies.writeOutput(`${JSON.stringify({
    schemaVersion: "pintpath-permanent-staging-cold-quiesce-output/v1",
    operation: "cold-quiesce",
    outcome,
    failureCode,
    candidateSha: args?.candidateSha ?? null,
    sourceSha: args?.expectedDeploymentSha ?? null,
    configuredReplicasBefore: before?.configuredReplicas ?? null,
    configuredReplicasAfter: after?.configuredReplicas ?? null,
    legacyReplicasBefore: before?.numReplicas ?? null,
    legacyReplicasAfter: after?.numReplicas ?? null,
    attempts,
    retryAllowed: false,
    prepareVerificationSha256: prerequisiteSha256,
    intentSha256,
    terminalSha256,
    configuredOneToZeroReceiptClaimed:
      (outcome === "configured_zero" ||
        outcome === "reconciled_configured_zero") &&
      resultChecks.exactZeroStateAfter &&
      resultChecks.configuredTopologyTransitionExact,
    checks: resultChecks,
  })}\n`);
  return successfulChecks(resultChecks, outcome) ? 0 : 1;
}

export const permanentStagingColdQuiesceInternals = { reconcile, successfulChecks };

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runProtectedPermanentStagingColdQuiesce();
}
