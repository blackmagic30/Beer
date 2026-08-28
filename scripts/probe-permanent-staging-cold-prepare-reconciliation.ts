import path from "node:path";
import { fileURLToPath } from "node:url";

import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";
import {
  authorityExact,
  canonical,
  COLD_RECOVERY_LOCK,
  COLD_RECOVERY_POLICY_SHA256,
  COLD_RECOVERY_SCOPE_QUERY,
  coldIdentityCanonical,
  defaultBoundaryCheck,
  fullStateCanonical,
  maintenanceRowsAfterExact,
  nonMaintenanceRows,
  parseColdPrepareReconcileReviewedAuthority,
  parseSupabaseReplacementPrerequisite,
  policyExact,
  probeRuntimeAbsent,
  railwayCall,
  readColdRecoveryState,
  readOnlyTokensExact,
  readPrivateEvidence,
  reconcilePrepareArgumentsExact,
  reassertRepositoryState,
  serviceRoleSealedExact,
  sha256,
  tokenScopeExact,
  writeDurable,
  type BoundaryEvidence,
  type ColdRecoveryState,
} from "./lib/permanent-staging-cold-recovery.js";

export const COLD_PREPARE_RECONCILIATION_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-cold-prepare-reconciliation/v1" as const;

interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  reviewedAuthorityExact: boolean;
  replacementPrerequisiteExact: boolean;
  tokenScopeExact: boolean;
  mutationCredentialsAbsent: boolean;
  boundaryPreflightExact: boolean;
  exactPreparedDeadStateBefore: boolean;
  maintenanceRowsBeforeExact: boolean;
  serviceRoleSealedBefore: boolean;
  runtimeAbsentBefore: boolean;
  durableObservationExact: boolean;
  repositoryReasserted: boolean;
  providerReasserted: boolean;
  runtimeReasserted: boolean;
  noProviderWriteAttempted: boolean;
  postflightAttempted: boolean;
  exactPreparedDeadStateAfter: boolean;
  maintenanceRowsAfterExact: boolean;
  serviceRoleSealedAfter: boolean;
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
  readonly readState: () => Promise<ColdRecoveryState | null>;
  readonly readPrivateEvidence: (filename: string) => string;
  readonly reassertRepositoryState: (cwd: string, candidateSha: string) => boolean;
  readonly probeRuntimeAbsent: () => Promise<boolean>;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

function emptyChecks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    reviewedAuthorityExact: false,
    replacementPrerequisiteExact: false,
    tokenScopeExact: false,
    mutationCredentialsAbsent: false,
    boundaryPreflightExact: false,
    exactPreparedDeadStateBefore: false,
    maintenanceRowsBeforeExact: false,
    serviceRoleSealedBefore: false,
    runtimeAbsentBefore: false,
    durableObservationExact: false,
    repositoryReasserted: false,
    providerReasserted: false,
    runtimeReasserted: false,
    noProviderWriteAttempted: true,
    postflightAttempted: false,
    exactPreparedDeadStateAfter: false,
    maintenanceRowsAfterExact: false,
    serviceRoleSealedAfter: false,
    deploymentSourceAndTopologyUnchanged: false,
    collateralVariablesUnchanged: false,
    runtimeAbsentAfter: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
  };
}

function allChecks(value: Checks): boolean {
  return Object.values(value).every((check) => check === true);
}

export async function runPermanentStagingColdPrepareReconciliationProbe(
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
    readState: () => readColdRecoveryState(
      dependencies.fetchImpl,
      dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "",
      null,
    ),
    readPrivateEvidence,
    reassertRepositoryState,
    probeRuntimeAbsent: () => probeRuntimeAbsent(
      dependencies.fetchImpl,
      dependencies.sleep,
    ),
    writeDurable,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const startedAt = new Date(dependencies.now()).toISOString();
  const checks = emptyChecks();
  const args = reconcilePrepareArgumentsExact(dependencies.argv);
  let before: ColdRecoveryState | null = null;
  let after: ColdRecoveryState | null = null;
  let replacementTerminalSha256: string | null = null;
  let reviewedAuthoritySha256: string | null = null;
  let observationSha256: string | null = null;
  let terminalSha256: string | null = null;
  let boundaryBefore: BoundaryEvidence = { passed: false, receiptSha256: null };
  let boundaryAfter: BoundaryEvidence = { passed: false, receiptSha256: null };
  let failureCode: string | null = null;
  let outcome: "reconciled_prepared_after_runner_loss" | "probe_failed" =
    "probe_failed";

  try {
    checks.policyExact = policyExact(dependencies.cwd);
    if (!args || !checks.policyExact) throw new Error("policy_or_arguments_invalid");
    checks.githubAuthorityExact = authorityExact(
      dependencies.env,
      "reconcile-prepare",
      args.candidateSha,
      args.expectedDeploymentSha,
    );
    if (!checks.githubAuthorityExact) throw new Error("authority_invalid");
    const reviewedSource = dependencies.readPrivateEvidence(args.reviewedAuthorityFile);
    reviewedAuthoritySha256 = sha256(reviewedSource);
    const reviewed = parseColdPrepareReconcileReviewedAuthority(
      reviewedSource,
      args.candidateSha,
      dependencies.env.GITHUB_RUN_ID ?? "",
      args.priorPrepareRunId,
      args.replacementRunId,
    );
    checks.reviewedAuthorityExact = reviewed?.sha256 === reviewedAuthoritySha256;
    if (!checks.reviewedAuthorityExact) throw new Error("reviewed_authority_invalid");
    const replacementSource = dependencies.readPrivateEvidence(
      args.replacementTerminalFile,
    );
    replacementTerminalSha256 = sha256(replacementSource);
    const replacement = parseSupabaseReplacementPrerequisite(
      replacementSource,
      args.candidateSha,
    );
    checks.replacementPrerequisiteExact =
      replacement?.terminalSha256 === replacementTerminalSha256;
    if (!checks.replacementPrerequisiteExact) throw new Error("replacement_invalid");
    const tokens = readOnlyTokensExact(dependencies.env);
    checks.mutationCredentialsAbsent = tokens !== null;
    if (!tokens) throw new Error("token_invalid");
    checks.tokenScopeExact = tokenScopeExact(await railwayCall(
      dependencies.fetchImpl,
      tokens.metadata,
      COLD_RECOVERY_SCOPE_QUERY,
      {},
    ));
    if (!checks.tokenScopeExact) throw new Error("token_scope_invalid");
    boundaryBefore = await dependencies.boundaryCheck();
    checks.boundaryPreflightExact = boundaryBefore.passed &&
      boundaryBefore.receiptSha256 !== null;
    if (!checks.boundaryPreflightExact) throw new Error("boundary_invalid");
    before = await dependencies.readState();
    checks.exactPreparedDeadStateBefore = before !== null &&
      before.numReplicas === null;
    checks.maintenanceRowsBeforeExact = before !== null &&
      maintenanceRowsAfterExact(before.rows);
    checks.serviceRoleSealedBefore = before !== null &&
      serviceRoleSealedExact(before.rows);
    checks.runtimeAbsentBefore = await dependencies.probeRuntimeAbsent();
    if (!checks.exactPreparedDeadStateBefore || !checks.maintenanceRowsBeforeExact ||
      !checks.serviceRoleSealedBefore || !checks.runtimeAbsentBefore) {
      throw new Error("prepared_state_invalid");
    }
    const observation = canonical({
      schemaVersion:
        "pintpath-permanent-staging-cold-prepare-reconciliation-observation/v1",
      policySha256: COLD_RECOVERY_POLICY_SHA256,
      operation: "cold-reconcile-prepare",
      candidateSha: args.candidateSha,
      expectedDeploymentSha: args.expectedDeploymentSha,
      replacementRunId: args.replacementRunId,
      replacementTerminalSha256,
      priorAmbiguousPrepareRunId: args.priorPrepareRunId,
      reviewedAuthoritySha256,
      projectId: COLD_RECOVERY_LOCK.projectId,
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      replicasObserved: null,
      providerBeforeSha256: sha256(fullStateCanonical(before!)),
      boundaryPreflightReceiptSha256: boundaryBefore.receiptSha256,
      providerMutationAllowed: false,
      mutationCredentialsAllowed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    observationSha256 = dependencies.writeDurable(
      args.evidenceDirectory,
      "cold-prepare-reconciliation-observation.json",
      observation,
    );
    checks.durableObservationExact = observationSha256 === sha256(observation);
    if (!checks.durableObservationExact) throw new Error("observation_invalid");
    checks.repositoryReasserted = dependencies.reassertRepositoryState(
      dependencies.cwd,
      args.candidateSha,
    );
    if (!checks.repositoryReasserted) throw new Error("repository_drift");
    const reasserted = await dependencies.readState();
    checks.providerReasserted = reasserted !== null &&
      fullStateCanonical(reasserted) === fullStateCanonical(before!);
    checks.runtimeReasserted = await dependencies.probeRuntimeAbsent();
    if (!checks.providerReasserted || !checks.runtimeReasserted) {
      throw new Error("state_drift");
    }
    checks.postflightAttempted = true;
    after = await dependencies.readState();
    checks.exactPreparedDeadStateAfter = after !== null &&
      after.numReplicas === null;
    checks.maintenanceRowsAfterExact = after !== null &&
      maintenanceRowsAfterExact(after.rows);
    checks.serviceRoleSealedAfter = after !== null &&
      serviceRoleSealedExact(after.rows);
    checks.deploymentSourceAndTopologyUnchanged = after !== null &&
      coldIdentityCanonical(after) === coldIdentityCanonical(before!);
    checks.collateralVariablesUnchanged = after !== null &&
      canonical(nonMaintenanceRows(after.rows)) ===
        canonical(nonMaintenanceRows(before!.rows));
    checks.runtimeAbsentAfter = await dependencies.probeRuntimeAbsent();
    boundaryAfter = await dependencies.boundaryCheck();
    checks.boundaryPostflightExact = boundaryAfter.passed &&
      boundaryAfter.receiptSha256 !== null;
    if (!Object.entries(checks)
      .filter(([name]) => name !== "terminalEvidenceExact")
      .every(([, value]) => value === true)) throw new Error("reconciliation_invalid");
    outcome = "reconciled_prepared_after_runner_loss";
  } catch (error) {
    failureCode = error instanceof Error ? error.message : "unexpected_failure";
  }

  if (outcome === "reconciled_prepared_after_runner_loss" && args && before && after) {
    const receipt = canonical({
      schemaVersion: COLD_PREPARE_RECONCILIATION_RECEIPT_SCHEMA,
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      operation: "cold-prepare",
      target: "permanent-staging",
      outcome,
      failureCode: null,
      candidateSha: args.candidateSha,
      sourceSha: args.expectedDeploymentSha,
      startedAt,
      completedAt: new Date(dependencies.now()).toISOString(),
      replicasBefore: null,
      replicasAfter: null,
      attempts: 0,
      retryAllowed: false,
      observationSha256,
      replacementPrerequisite: {
        runId: args.replacementRunId,
        terminalSha256: replacementTerminalSha256,
      },
      runnerLossReconciliation: {
        priorAmbiguousPrepareRunId: args.priorPrepareRunId,
        reviewedAuthoritySha256,
        mutationCredentialPresent: false,
        providerWriteAttempted: false,
      },
      providerEvidence: {
        deploymentIdSha256: railwayDeploymentIdentityIdSha256(
          "deployment",
          COLD_RECOVERY_LOCK.deploymentId,
        ),
        snapshotIdSha256: sha256(COLD_RECOVERY_LOCK.snapshotId),
        stateBeforeSha256: sha256(fullStateCanonical(before)),
        stateAfterSha256: sha256(fullStateCanonical(after)),
        topologyBeforeSha256: sha256(coldIdentityCanonical(before)),
        topologyAfterSha256: sha256(coldIdentityCanonical(after)),
        collateralVariablesBeforeSha256: sha256(canonical(
          nonMaintenanceRows(before.rows),
        )),
        collateralVariablesAfterSha256: sha256(canonical(
          nonMaintenanceRows(after.rows),
        )),
        sourceDisconnectedBefore: true,
        sourceDisconnectedAfter: true,
        stagedPatchEmptyBefore: true,
        stagedPatchEmptyAfter: true,
      },
      mutationBoundaryEvidence: {
        preflightReceiptSha256: boundaryBefore.receiptSha256,
        postflightReceiptSha256: boundaryAfter.receiptSha256,
      },
      checks: { ...checks, terminalEvidenceExact: true },
      nextRequiredProof: "EXACT_COLD_NULL_TO_ZERO_QUIESCENCE_PROOF",
      normalPrepareMutationReceiptClaimed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    try {
      terminalSha256 = dependencies.writeDurable(
        args.evidenceDirectory,
        "cold-prepare-terminal.json",
        receipt,
      );
      checks.terminalEvidenceExact = terminalSha256 === sha256(receipt);
    } catch {
      checks.terminalEvidenceExact = false;
    }
  }
  if (!checks.terminalEvidenceExact) {
    outcome = "probe_failed";
    failureCode ??= "terminal_evidence_failed";
  }
  dependencies.writeOutput(`${JSON.stringify({
    schemaVersion:
      "pintpath-permanent-staging-cold-prepare-reconciliation-output/v1",
    operation: "cold-reconcile-prepare",
    outcome,
    failureCode,
    candidateSha: args?.candidateSha ?? null,
    sourceSha: args?.expectedDeploymentSha ?? null,
    replicasBefore: before?.numReplicas ?? null,
    replicasAfter: after?.numReplicas ?? null,
    attempts: 0,
    priorAmbiguousPrepareRunId: args?.priorPrepareRunId ?? null,
    replacementTerminalSha256,
    reviewedAuthoritySha256,
    observationSha256,
    terminalSha256,
    checks,
  })}\n`);
  return outcome === "reconciled_prepared_after_runner_loss" && allChecks(checks)
    ? 0
    : 1;
}

if (process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPermanentStagingColdPrepareReconciliationProbe();
}
