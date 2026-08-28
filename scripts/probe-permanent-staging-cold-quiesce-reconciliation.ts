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
  parseColdReconcileReviewedAuthority,
  policyExact,
  probeRuntimeAbsent,
  railwayCall,
  readColdRecoveryState,
  readOnlyTokensExact,
  readPrivateEvidence,
  reconcileArgumentsExact,
  reassertRepositoryState,
  sha256,
  tokenScopeExact,
  writeDurable,
  type BoundaryEvidence,
  type ColdRecoveryState,
} from "./lib/permanent-staging-cold-recovery.js";
import {
  parseStagingWorkerBootstrapPrerequisitesVerification,
} from "./verify-permanent-staging-worker-bootstrap-prerequisites.js";

export const COLD_QUIESCE_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-cold-quiesce/v2" as const;

interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  reviewedAuthorityExact: boolean;
  preparePrerequisiteExact: boolean;
  tokenScopeExact: boolean;
  scaleCredentialAbsent: boolean;
  boundaryPreflightExact: boolean;
  exactZeroStateBefore: boolean;
  maintenanceRowsBeforeExact: boolean;
  runtimeAbsentBefore: boolean;
  durableObservationExact: boolean;
  repositoryReasserted: boolean;
  providerReasserted: boolean;
  runtimeReasserted: boolean;
  noProviderWriteAttempted: boolean;
  postflightAttempted: boolean;
  exactZeroStateAfter: boolean;
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
    preparePrerequisiteExact: false,
    tokenScopeExact: false,
    scaleCredentialAbsent: false,
    boundaryPreflightExact: false,
    exactZeroStateBefore: false,
    maintenanceRowsBeforeExact: false,
    runtimeAbsentBefore: false,
    durableObservationExact: false,
    repositoryReasserted: false,
    providerReasserted: false,
    runtimeReasserted: false,
    noProviderWriteAttempted: true,
    postflightAttempted: false,
    exactZeroStateAfter: false,
    maintenanceRowsAfterExact: false,
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

export async function runPermanentStagingColdQuiesceReconciliationProbe(
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
      0,
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
  const args = reconcileArgumentsExact(dependencies.argv);
  let before: ColdRecoveryState | null = null;
  let after: ColdRecoveryState | null = null;
  let prepareVerificationSha256: string | null = null;
  let reviewedAuthoritySha256: string | null = null;
  let intentSha256: string | null = null;
  let terminalSha256: string | null = null;
  let boundaryBefore: BoundaryEvidence = { passed: false, receiptSha256: null };
  let boundaryAfter: BoundaryEvidence = { passed: false, receiptSha256: null };
  let failureCode: string | null = null;
  let outcome: "reconciled_zero_after_runner_loss" | "probe_failed" = "probe_failed";

  try {
    checks.policyExact = policyExact(dependencies.cwd);
    if (!args || !checks.policyExact) throw new Error("policy_or_arguments_invalid");
    checks.githubAuthorityExact = authorityExact(
      dependencies.env,
      "reconcile-quiesce",
      args.candidateSha,
      args.expectedDeploymentSha,
    );
    if (!checks.githubAuthorityExact) throw new Error("authority_invalid");
    const reviewedSource = dependencies.readPrivateEvidence(args.reviewedAuthorityFile);
    reviewedAuthoritySha256 = sha256(reviewedSource);
    const reviewed = parseColdReconcileReviewedAuthority(
      reviewedSource,
      args.candidateSha,
      dependencies.env.GITHUB_RUN_ID ?? "",
      args.priorQuiesceRunId,
      args.prepareRunId,
    );
    checks.reviewedAuthorityExact = reviewed?.sha256 === reviewedAuthoritySha256;
    if (!checks.reviewedAuthorityExact) throw new Error("reviewed_authority_invalid");
    const prepareSource = dependencies.readPrivateEvidence(args.prepareVerificationFile);
    prepareVerificationSha256 = sha256(prepareSource);
    const prepare = parseStagingWorkerBootstrapPrerequisitesVerification(
      prepareSource,
      {
        operation: "cold-reconcile-quiesce",
        bootstrapPath: "cold-dead",
        candidateSha: args.candidateSha,
        currentRunId: dependencies.env.GITHUB_RUN_ID ?? "",
        now: new Date(dependencies.now()),
      },
    );
    checks.preparePrerequisiteExact = prepare.expectedDeploymentSha ===
      args.expectedDeploymentSha && prepare.prerequisites.length === 1 &&
      prepare.prerequisites[0]?.kind === "cold-prepare" &&
      prepare.prerequisites[0]?.runId === args.prepareRunId &&
      prepare.prerequisites[0]?.receipt.replicasBefore === null &&
      prepare.prerequisites[0]?.receipt.replicasAfter === null;
    if (!checks.preparePrerequisiteExact) throw new Error("prepare_invalid");
    const tokens = readOnlyTokensExact(dependencies.env);
    checks.scaleCredentialAbsent = tokens !== null;
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
    checks.exactZeroStateBefore = before !== null && before.numReplicas === 0;
    checks.maintenanceRowsBeforeExact = before !== null &&
      maintenanceRowsAfterExact(before.rows);
    if (!checks.exactZeroStateBefore || !checks.maintenanceRowsBeforeExact) {
      throw new Error("zero_state_invalid");
    }
    checks.runtimeAbsentBefore = await dependencies.probeRuntimeAbsent();
    if (!checks.runtimeAbsentBefore) throw new Error("runtime_present");
    const observation = canonical({
      schemaVersion:
        "pintpath-permanent-staging-cold-quiesce-reconciliation-observation/v1",
      policySha256: COLD_RECOVERY_POLICY_SHA256,
      operation: "cold-reconcile-quiesce",
      candidateSha: args.candidateSha,
      expectedDeploymentSha: args.expectedDeploymentSha,
      prepareRunId: args.prepareRunId,
      prepareVerificationSha256,
      priorAmbiguousQuiesceRunId: args.priorQuiesceRunId,
      reviewedAuthoritySha256,
      projectId: COLD_RECOVERY_LOCK.projectId,
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      deploymentIdSha256: railwayDeploymentIdentityIdSha256(
        "deployment",
        COLD_RECOVERY_LOCK.deploymentId,
      ),
      replicasObserved: 0,
      providerBeforeSha256: sha256(fullStateCanonical(before!)),
      boundaryPreflightReceiptSha256: boundaryBefore.receiptSha256,
      providerMutationAllowed: false,
      scaleCredentialAllowed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    intentSha256 = dependencies.writeDurable(
      args.evidenceDirectory,
      "cold-quiesce-reconciliation-observation.json",
      observation,
    );
    checks.durableObservationExact = intentSha256 === sha256(observation);
    if (!checks.durableObservationExact) throw new Error("observation_invalid");
    checks.repositoryReasserted = dependencies.reassertRepositoryState(
      dependencies.cwd,
      args.candidateSha,
    );
    if (!checks.repositoryReasserted) throw new Error("repository_drift");
    const reasserted = await dependencies.readState();
    checks.providerReasserted = reasserted !== null &&
      fullStateCanonical(reasserted) === fullStateCanonical(before!);
    if (!checks.providerReasserted) throw new Error("provider_drift");
    checks.runtimeReasserted = await dependencies.probeRuntimeAbsent();
    if (!checks.runtimeReasserted) throw new Error("runtime_present");

    checks.postflightAttempted = true;
    after = await dependencies.readState();
    checks.exactZeroStateAfter = after !== null && after.numReplicas === 0;
    checks.maintenanceRowsAfterExact = after !== null &&
      maintenanceRowsAfterExact(after.rows);
    checks.deploymentSourceAndTopologyUnchanged = after !== null &&
      coldIdentityCanonical(after) === coldIdentityCanonical(before!);
    checks.collateralVariablesUnchanged = after !== null &&
      canonical(nonMaintenanceRows(after.rows)) ===
        canonical(nonMaintenanceRows(before!.rows));
    checks.runtimeAbsentAfter = await dependencies.probeRuntimeAbsent();
    boundaryAfter = await dependencies.boundaryCheck();
    checks.boundaryPostflightExact = boundaryAfter.passed &&
      boundaryAfter.receiptSha256 !== null;
    const successfulWithoutTerminal = Object.entries(checks)
      .filter(([name]) => name !== "terminalEvidenceExact")
      .every(([, value]) => value === true);
    if (!successfulWithoutTerminal) throw new Error("reconciliation_invalid");
    outcome = "reconciled_zero_after_runner_loss";
  } catch (error) {
    failureCode = error instanceof Error ? error.message : "unexpected_failure";
  }

  if (outcome === "reconciled_zero_after_runner_loss" && args && before && after) {
    const receipt = canonical({
      schemaVersion: COLD_QUIESCE_RECEIPT_SCHEMA,
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      operation: "cold-quiesce",
      target: "permanent-staging",
      outcome,
      failureCode: null,
      candidateSha: args.candidateSha,
      sourceSha: args.expectedDeploymentSha,
      startedAt,
      completedAt: new Date(dependencies.now()).toISOString(),
      replicasBefore: 0,
      replicasAfter: 0,
      attempts: 0,
      retryAllowed: false,
      intentSha256,
      preparePrerequisite: {
        runId: args.prepareRunId,
        verificationSha256: prepareVerificationSha256,
      },
      runnerLossReconciliation: {
        priorAmbiguousQuiesceRunId: args.priorQuiesceRunId,
        reviewedAuthoritySha256,
        scaleCredentialPresent: false,
        providerWriteAttempted: false,
      },
      commandEvidence: {
        exitCode: null,
        timedOut: false,
        stdoutSha256: null,
        stderrSha256: null,
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
        collateralVariablesBeforeSha256: sha256(canonical(nonMaintenanceRows(before.rows))),
        collateralVariablesAfterSha256: sha256(canonical(nonMaintenanceRows(after.rows))),
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
      nextRequiredProof: "EXACT_CANDIDATE_UPLOAD_AT_EXPLICIT_ZERO",
      normalOneToZeroReceiptClaimed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    try {
      terminalSha256 = dependencies.writeDurable(
        args.evidenceDirectory,
        "cold-quiesce-receipt.json",
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
    schemaVersion: "pintpath-permanent-staging-cold-quiesce-reconciliation-output/v1",
    operation: "cold-reconcile-quiesce",
    outcome,
    failureCode,
    candidateSha: args?.candidateSha ?? null,
    sourceSha: args?.expectedDeploymentSha ?? null,
    replicasBefore: before?.numReplicas ?? null,
    replicasAfter: after?.numReplicas ?? null,
    attempts: 0,
    priorAmbiguousQuiesceRunId: args?.priorQuiesceRunId ?? null,
    prepareVerificationSha256,
    reviewedAuthoritySha256,
    intentSha256,
    terminalSha256,
    checks,
  })}\n`);
  return outcome === "reconciled_zero_after_runner_loss" && allChecks(checks)
    ? 0
    : 1;
}

if (process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPermanentStagingColdQuiesceReconciliationProbe();
}
