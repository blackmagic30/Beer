import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  argumentsExact,
  authorityExact,
  canonical,
  COLD_RECOVERY_LOCK,
  COLD_RECOVERY_POLICY_SHA256,
  coldIdentityCanonical,
  defaultBoundaryCheck,
  fullStateCanonical,
  maintenanceRowsAfterExact,
  nonMaintenanceRows,
  policyExact,
  probeRuntimeAbsent,
  railwayCall,
  readColdRecoveryState,
  readPrivateEvidence,
  reassertRepositoryState,
  runScaleCommand,
  sha256,
  tokenScopeExact,
  tokensExact,
  validateCli,
  writeDurable,
  COLD_RECOVERY_SCOPE_QUERY,
  type BoundaryEvidence,
  type ColdRecoveryState,
  type CommandResult,
} from "./lib/permanent-staging-cold-recovery.js";
import {
  parseStagingWorkerBootstrapPrerequisitesVerification,
} from "./verify-permanent-staging-worker-bootstrap-prerequisites.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";

export const COLD_QUIESCE_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-cold-quiesce/v2" as const;

interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  preparePrerequisiteExact: boolean;
  tokenScopesExact: boolean;
  cliExact: boolean;
  boundaryPreflightExact: boolean;
  exactDeadStateBefore: boolean;
  maintenanceRowsBeforeExact: boolean;
  runtimeAbsentBefore: boolean;
  durableIntentExact: boolean;
  repositoryPrewriteReasserted: boolean;
  providerPrewriteReasserted: boolean;
  runtimePrewriteReasserted: boolean;
  writeAttemptedAtMostOnce: boolean;
  acknowledgementExact: boolean;
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
  readonly readState: (replicas: null | 0) => Promise<ColdRecoveryState | null>;
  readonly readPrivateEvidence: (filename: string) => string;
  readonly reassertRepositoryState: (cwd: string, candidateSha: string) => boolean;
  readonly probeRuntimeAbsent: () => Promise<boolean>;
  readonly validateCli: (filename: string) => boolean;
  readonly runScaleCommand: (executable: string, token: string) => Promise<CommandResult>;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

function emptyChecks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    preparePrerequisiteExact: false,
    tokenScopesExact: false,
    cliExact: false,
    boundaryPreflightExact: false,
    exactDeadStateBefore: false,
    maintenanceRowsBeforeExact: false,
    runtimeAbsentBefore: false,
    durableIntentExact: false,
    repositoryPrewriteReasserted: false,
    providerPrewriteReasserted: false,
    runtimePrewriteReasserted: false,
    writeAttemptedAtMostOnce: true,
    acknowledgementExact: false,
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

function successfulChecks(
  value: Checks,
  outcome: "initialized_zero" | "reconciled_success" | "failed_before_attempt" |
    "mutation_uncertain",
): boolean {
  const common = Object.entries(value).filter(
    ([name]) => name !== "acknowledgementExact",
  ).every(([, check]) => check === true);
  return common && ((outcome === "initialized_zero" && value.acknowledgementExact) ||
    (outcome === "reconciled_success" && !value.acknowledgementExact));
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
    validateCli,
    runScaleCommand,
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
  let failureCode: string | null = null;
  let outcome: "initialized_zero" | "reconciled_success" |
    "failed_before_attempt" | "mutation_uncertain" = "failed_before_attempt";
  let boundaryBefore: BoundaryEvidence = { passed: false, receiptSha256: null };
  let boundaryAfter: BoundaryEvidence = { passed: false, receiptSha256: null };
  let command: CommandResult | null = null;
  let tokens: ReturnType<typeof tokensExact> = null;

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
      prerequisite.prerequisites[0]?.receipt.replicasBefore === null &&
      prerequisite.prerequisites[0]?.receipt.replicasAfter === null;
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
    const cli = dependencies.env.PINTPATH_RAILWAY_CLI_PATH ?? "";
    resultChecks.cliExact = path.isAbsolute(cli) && dependencies.validateCli(cli);
    if (!resultChecks.cliExact) throw new Error("cli_invalid");
    boundaryBefore = await dependencies.boundaryCheck();
    resultChecks.boundaryPreflightExact = boundaryBefore.passed &&
      boundaryBefore.receiptSha256 !== null;
    if (!resultChecks.boundaryPreflightExact) throw new Error("boundary_invalid");
    before = await dependencies.readState(null);
    resultChecks.exactDeadStateBefore = before !== null;
    resultChecks.maintenanceRowsBeforeExact = before !== null &&
      maintenanceRowsAfterExact(before.rows);
    if (!resultChecks.exactDeadStateBefore || !resultChecks.maintenanceRowsBeforeExact) {
      throw new Error("dead_state_invalid");
    }
    resultChecks.runtimeAbsentBefore = await dependencies.probeRuntimeAbsent();
    if (!resultChecks.runtimeAbsentBefore) throw new Error("runtime_present");
    const intent = canonical({
      schemaVersion: "pintpath-permanent-staging-cold-quiesce-intent/v1",
      policySha256: COLD_RECOVERY_POLICY_SHA256,
      operation: "cold-quiesce",
      candidateSha: args.candidateSha,
      expectedDeploymentSha: args.expectedDeploymentSha,
      prepareRunId: args.prepareRunId,
      prepareVerificationSha256: prerequisiteSha256,
      projectId: COLD_RECOVERY_LOCK.projectId,
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      deploymentIdSha256: railwayDeploymentIdentityIdSha256(
        "deployment",
        COLD_RECOVERY_LOCK.deploymentId,
      ),
      replicasBefore: null,
      replicasAfter: 0,
      providerBeforeSha256: sha256(fullStateCanonical(before!)),
      boundaryPreflightReceiptSha256: boundaryBefore.receiptSha256,
      maximumAttempts: 1,
      retryAllowed: false,
      normalOneToZeroReceiptClaimed: false,
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
    const prewrite = await dependencies.readState(null);
    resultChecks.providerPrewriteReasserted = prewrite !== null &&
      fullStateCanonical(prewrite) === fullStateCanonical(before!);
    if (!resultChecks.providerPrewriteReasserted) throw new Error("provider_drift");
    resultChecks.runtimePrewriteReasserted = await dependencies.probeRuntimeAbsent();
    if (!resultChecks.runtimePrewriteReasserted) throw new Error("runtime_present");

    attempts = 1;
    try {
      command = await dependencies.runScaleCommand(cli, tokens.mutation);
    } catch {
      command = null;
    }
    resultChecks.acknowledgementExact = command?.code === 0 &&
      command?.timedOut === false;
  } catch (error) {
    failureCode = error instanceof Error ? error.message : "unexpected_failure";
  } finally {
    if (attempts === 1 && before !== null) {
      resultChecks.postflightAttempted = true;
      try { after = await reconcile(dependencies); } catch { after = null; }
      resultChecks.exactZeroStateAfter = after !== null;
      resultChecks.maintenanceRowsAfterExact = after !== null &&
        maintenanceRowsAfterExact(after.rows);
      resultChecks.deploymentSourceAndTopologyUnchanged = after !== null &&
        coldIdentityCanonical(after) === coldIdentityCanonical(before) &&
        before.numReplicas === null && after.numReplicas === 0;
      resultChecks.collateralVariablesUnchanged = after !== null &&
        canonical(nonMaintenanceRows(after.rows)) ===
          canonical(nonMaintenanceRows(before.rows));
      try { resultChecks.runtimeAbsentAfter = await dependencies.probeRuntimeAbsent(); } catch {
        resultChecks.runtimeAbsentAfter = false;
      }
      try { boundaryAfter = await dependencies.boundaryCheck(); } catch {
        boundaryAfter = { passed: false, receiptSha256: null };
      }
      resultChecks.boundaryPostflightExact = boundaryAfter.passed &&
        boundaryAfter.receiptSha256 !== null;
      const successfulWithoutTerminalOrAcknowledgement = Object.entries(resultChecks)
        .filter(([name]) =>
          name !== "terminalEvidenceExact" && name !== "acknowledgementExact")
        .every(([, value]) => value === true);
      if (successfulWithoutTerminalOrAcknowledgement) {
        failureCode = null;
        outcome = resultChecks.acknowledgementExact
          ? "initialized_zero"
          : "reconciled_success";
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
      completedAt: new Date(dependencies.now()).toISOString(),
      replicasBefore: null,
      replicasAfter: 0,
      attempts,
      retryAllowed: false,
      intentSha256,
      preparePrerequisite: {
        runId: args.prepareRunId,
        verificationSha256: prerequisiteSha256,
      },
      runnerLossReconciliation: null,
      commandEvidence: {
        exitCode: command?.code ?? null,
        timedOut: command?.timedOut ?? false,
        stdoutSha256: command?.stdoutSha256 ?? null,
        stderrSha256: command?.stderrSha256 ?? null,
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
    replicasBefore: null,
    replicasAfter: 0,
    attempts,
    retryAllowed: false,
    prepareVerificationSha256: prerequisiteSha256,
    intentSha256,
    terminalSha256,
    normalOneToZeroReceiptClaimed: false,
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
