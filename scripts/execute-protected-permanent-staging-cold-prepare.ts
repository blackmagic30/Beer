import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  argumentsExact,
  authorityExact,
  canonical,
  COLD_RECOVERY_LOCK,
  COLD_RECOVERY_POLICY_SHA256,
  COLD_RECOVERY_PREPARE_MUTATION,
  COLD_RECOVERY_SCOPE_QUERY,
  coldIdentityCanonical,
  defaultBoundaryCheck,
  fullStateCanonical,
  maintenanceRowsAfterExact,
  maintenanceRowsBeforeExact,
  nonMaintenanceRows,
  policyExact,
  railwayCall,
  readPrivateEvidence,
  readColdRecoveryState,
  reassertRepositoryState,
  parseSupabaseReplacementPrerequisite,
  serviceRoleSealedExact,
  sha256,
  tokenScopeExact,
  tokensExact,
  writeDurable,
  type BoundaryEvidence,
  type ColdRecoveryState,
} from "./lib/permanent-staging-cold-recovery.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";

export const COLD_PREPARE_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-cold-prepare/v1" as const;

interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  replacementPrerequisiteExact: boolean;
  tokenScopesExact: boolean;
  boundaryPreflightExact: boolean;
  exactDeadStateBefore: boolean;
  requiredVariablesBeforeExact: boolean;
  serviceRoleSealedBefore: boolean;
  durableIntentExact: boolean;
  repositoryPrewriteReasserted: boolean;
  providerPrewriteReasserted: boolean;
  writeAttemptedAtMostOnce: boolean;
  atomicVariablesExact: boolean;
  acknowledgementExact: boolean;
  postflightAttempted: boolean;
  exactDeadStateAfter: boolean;
  maintenanceRowsAfterExact: boolean;
  deploymentAndTopologyUnchanged: boolean;
  collateralVariablesUnchanged: boolean;
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
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

function checks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    replacementPrerequisiteExact: false,
    tokenScopesExact: false,
    boundaryPreflightExact: false,
    exactDeadStateBefore: false,
    requiredVariablesBeforeExact: false,
    serviceRoleSealedBefore: false,
    durableIntentExact: false,
    repositoryPrewriteReasserted: false,
    providerPrewriteReasserted: false,
    writeAttemptedAtMostOnce: true,
    atomicVariablesExact: false,
    acknowledgementExact: false,
    postflightAttempted: false,
    exactDeadStateAfter: false,
    maintenanceRowsAfterExact: false,
    deploymentAndTopologyUnchanged: false,
    collateralVariablesUnchanged: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
  };
}

function allRequiredChecks(value: Checks): boolean {
  return Object.values(value).every((check) => check === true);
}

async function reconcile(
  dependencies: Dependencies,
): Promise<ColdRecoveryState | null> {
  const deadline = dependencies.now() + 60_000;
  do {
    const state = await dependencies.readState(null);
    if (state && maintenanceRowsAfterExact(state.rows)) return state;
    if (dependencies.now() >= deadline) break;
    await dependencies.sleep(5_000);
  } while (dependencies.now() <= deadline);
  return null;
}

export async function runProtectedPermanentStagingColdPrepare(
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
    writeDurable,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const startedAt = new Date(dependencies.now()).toISOString();
  const resultChecks = checks();
  const args = argumentsExact(dependencies.argv, false);
  let before: ColdRecoveryState | null = null;
  let after: ColdRecoveryState | null = null;
  let attempts: 0 | 1 = 0;
  let intentSha256: string | null = null;
  let terminalSha256: string | null = null;
  let replacementPrerequisiteSha256: string | null = null;
  let failureCode: string | null = null;
  let outcome: "prepared_cold" | "failed_before_attempt" | "mutation_uncertain" =
    "failed_before_attempt";
  let boundaryBefore: BoundaryEvidence = { passed: false, receiptSha256: null };
  let boundaryAfter: BoundaryEvidence = { passed: false, receiptSha256: null };
  let tokens: ReturnType<typeof tokensExact> = null;

  try {
    resultChecks.policyExact = policyExact(dependencies.cwd);
    if (!args || !resultChecks.policyExact) throw new Error("policy_or_arguments_invalid");
    resultChecks.githubAuthorityExact = authorityExact(
      dependencies.env,
      "prepare",
      args.candidateSha,
      args.expectedDeploymentSha,
    );
    if (!resultChecks.githubAuthorityExact) throw new Error("authority_invalid");
    const replacementPrerequisiteSource = dependencies.readPrivateEvidence(
      args.replacementTerminalFile!,
    );
    const replacementPrerequisite = parseSupabaseReplacementPrerequisite(
      replacementPrerequisiteSource,
      args.candidateSha,
    );
    replacementPrerequisiteSha256 = sha256(replacementPrerequisiteSource);
    resultChecks.replacementPrerequisiteExact = replacementPrerequisite !== null &&
      replacementPrerequisite.terminalSha256 === replacementPrerequisiteSha256;
    if (!resultChecks.replacementPrerequisiteExact) {
      throw new Error("replacement_prerequisite_invalid");
    }
    tokens = tokensExact(dependencies.env, "prepare");
    if (!tokens) throw new Error("token_invalid");
    const [metadataScope, mutationScope] = await Promise.all([
      railwayCall(
        dependencies.fetchImpl,
        tokens.metadata,
        COLD_RECOVERY_SCOPE_QUERY,
        {},
      ),
      railwayCall(
        dependencies.fetchImpl,
        tokens.mutation,
        COLD_RECOVERY_SCOPE_QUERY,
        {},
      ),
    ]);
    resultChecks.tokenScopesExact = tokenScopeExact(metadataScope) &&
      tokenScopeExact(mutationScope);
    if (!resultChecks.tokenScopesExact) throw new Error("token_scope_invalid");
    boundaryBefore = await dependencies.boundaryCheck();
    resultChecks.boundaryPreflightExact = boundaryBefore.passed &&
      boundaryBefore.receiptSha256 !== null;
    if (!resultChecks.boundaryPreflightExact) throw new Error("boundary_invalid");
    before = await dependencies.readState(null);
    resultChecks.exactDeadStateBefore = before !== null;
    resultChecks.requiredVariablesBeforeExact = before !== null &&
      maintenanceRowsBeforeExact(before.rows);
    resultChecks.serviceRoleSealedBefore = before !== null &&
      serviceRoleSealedExact(before.rows);
    if (!resultChecks.exactDeadStateBefore ||
      !resultChecks.requiredVariablesBeforeExact ||
      !resultChecks.serviceRoleSealedBefore) {
      throw new Error("dead_state_invalid");
    }
    const configuredVariables = {
      PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED: "false",
      PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: args.candidateSha,
    } as const;
    const intent = canonical({
      schemaVersion: "pintpath-permanent-staging-cold-prepare-intent/v1",
      policySha256: COLD_RECOVERY_POLICY_SHA256,
      operation: "cold-prepare",
      candidateSha: args.candidateSha,
      expectedDeploymentSha: args.expectedDeploymentSha,
      projectId: COLD_RECOVERY_LOCK.projectId,
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      deploymentIdSha256: railwayDeploymentIdentityIdSha256(
        "deployment",
        COLD_RECOVERY_LOCK.deploymentId,
      ),
      replicasBefore: null,
      replicasAfter: null,
      configuredVariables,
      replacementPrerequisite: {
        runId: args.replacementRunId,
        terminalSha256: replacementPrerequisiteSha256,
      },
      skipDeploys: true,
      providerBeforeSha256: sha256(fullStateCanonical(before!)),
      boundaryPreflightReceiptSha256: boundaryBefore.receiptSha256,
      maximumAttempts: 1,
      retryAllowed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    intentSha256 = dependencies.writeDurable(
      args.evidenceDirectory,
      "cold-prepare-intent.json",
      intent,
    );
    resultChecks.durableIntentExact = intentSha256 === sha256(intent);
    if (!resultChecks.durableIntentExact) throw new Error("intent_invalid");
    resultChecks.repositoryPrewriteReasserted = dependencies.reassertRepositoryState(
      dependencies.cwd,
      args.candidateSha,
    );
    if (!resultChecks.repositoryPrewriteReasserted) {
      throw new Error("repository_drift");
    }
    const prewrite = await dependencies.readState(null);
    resultChecks.providerPrewriteReasserted = prewrite !== null &&
      fullStateCanonical(prewrite) === fullStateCanonical(before!);
    if (!resultChecks.providerPrewriteReasserted) throw new Error("provider_drift");

    attempts = 1;
    const response = await railwayCall(
      dependencies.fetchImpl,
      tokens.mutation,
      COLD_RECOVERY_PREPARE_MUTATION,
      {
        projectId: COLD_RECOVERY_LOCK.projectId,
        serviceId: COLD_RECOVERY_LOCK.serviceId,
        environmentId: COLD_RECOVERY_LOCK.environmentId,
        variables: configuredVariables,
        skipDeploys: true,
      },
    );
    resultChecks.atomicVariablesExact = Object.keys(configuredVariables).length === 2;
    resultChecks.acknowledgementExact = typeof response === "object" &&
      response !== null &&
      !Array.isArray(response) &&
      (response as { data?: { variableCollectionUpsert?: unknown } }).data
          ?.variableCollectionUpsert === true;
  } catch (error) {
    failureCode = error instanceof Error ? error.message : "unexpected_failure";
  } finally {
    if (attempts === 1 && before !== null) {
      resultChecks.postflightAttempted = true;
      try { after = await reconcile(dependencies); } catch { after = null; }
      resultChecks.exactDeadStateAfter = after !== null;
      resultChecks.maintenanceRowsAfterExact = after !== null &&
        maintenanceRowsAfterExact(after.rows);
      resultChecks.deploymentAndTopologyUnchanged = after !== null &&
        coldIdentityCanonical(after) === coldIdentityCanonical(before) &&
        after.numReplicas === null;
      resultChecks.collateralVariablesUnchanged = after !== null &&
        canonical(nonMaintenanceRows(after.rows)) ===
          canonical(nonMaintenanceRows(before.rows));
      try { boundaryAfter = await dependencies.boundaryCheck(); } catch {
        boundaryAfter = { passed: false, receiptSha256: null };
      }
      resultChecks.boundaryPostflightExact = boundaryAfter.passed &&
        boundaryAfter.receiptSha256 !== null;
      const successfulWithoutTerminal = Object.entries(resultChecks)
        .filter(([name]) => name !== "terminalEvidenceExact")
        .every(([, value]) => value === true);
      if (!successfulWithoutTerminal) failureCode ??= "reconciliation_failed";
      outcome = failureCode === null ? "prepared_cold" : "mutation_uncertain";
    }
  }

  if (attempts === 1 && args && before) {
    const receipt = canonical({
      schemaVersion: COLD_PREPARE_RECEIPT_SCHEMA,
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      operation: "cold-prepare",
      target: "permanent-staging",
      outcome,
      failureCode,
      candidateSha: args.candidateSha,
      sourceSha: args.expectedDeploymentSha,
      startedAt,
      completedAt: new Date(dependencies.now()).toISOString(),
      replicasBefore: null,
      replicasAfter: null,
      attempts,
      retryAllowed: false,
      intentSha256,
      replacementPrerequisite: {
        runId: args.replacementRunId,
        terminalSha256: replacementPrerequisiteSha256,
      },
      providerEvidence: {
        graphqlOperation: "variableCollectionUpsert",
        acknowledgementExact: resultChecks.acknowledgementExact,
        deploymentIdSha256: railwayDeploymentIdentityIdSha256(
          "deployment",
          COLD_RECOVERY_LOCK.deploymentId,
        ),
        snapshotIdSha256: sha256(COLD_RECOVERY_LOCK.snapshotId),
        stateBeforeSha256: sha256(fullStateCanonical(before)),
        stateAfterSha256: after ? sha256(fullStateCanonical(after)) : null,
        topologyBeforeSha256: sha256(coldIdentityCanonical(before)),
        topologyAfterSha256: after
          ? sha256(coldIdentityCanonical(after))
          : null,
        collateralVariablesBeforeSha256: sha256(canonical(
          nonMaintenanceRows(before.rows),
        )),
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
      nextRequiredProof: "EXACT_COLD_NULL_TO_ZERO_QUIESCENCE_PROOF",
      normalOneToZeroReceiptClaimed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    try {
      terminalSha256 = dependencies.writeDurable(
        args.evidenceDirectory,
        "cold-prepare-terminal.json",
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
    schemaVersion: "pintpath-permanent-staging-cold-prepare-output/v1",
    operation: "cold-prepare",
    outcome,
    failureCode,
    candidateSha: args?.candidateSha ?? null,
    sourceSha: args?.expectedDeploymentSha ?? null,
    replicasBefore: null,
    replicasAfter: null,
    attempts,
    retryAllowed: false,
    intentSha256,
    replacementPrerequisiteSha256,
    terminalSha256,
    checks: resultChecks,
  })}\n`);
  return outcome === "prepared_cold" && allRequiredChecks(resultChecks) ? 0 : 1;
}

export const permanentStagingColdPrepareInternals = {
  reconcile,
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runProtectedPermanentStagingColdPrepare();
}
