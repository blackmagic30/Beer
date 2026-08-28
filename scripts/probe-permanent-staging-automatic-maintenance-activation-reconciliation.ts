import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRailwayMutationBoundaryCheck } from
  "./check-railway-mutation-boundary.js";
import {
  AUTOMATIC_MAINTENANCE_WORKER_FENCE_DEPLOYMENT_QUERY,
  AUTOMATIC_MAINTENANCE_WORKER_FENCE_EXECUTOR_STATE,
  AUTOMATIC_MAINTENANCE_WORKER_FENCE_METADATA_QUERY,
  AUTOMATIC_MAINTENANCE_WORKER_FENCE_POLICY_SHA256,
  AUTOMATIC_MAINTENANCE_WORKER_FENCE_SCOPE_QUERY,
  automaticMaintenanceWorkerFenceInternals,
} from "./execute-protected-automatic-maintenance-worker-fence.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";
import {
  parseRailwayApplicationDeploymentAttestationRuntimeResponse,
} from "../src/lib/railway-application-deployment-attestation.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";
import {
  parseStagingWorkerBootstrapPrerequisitesVerification,
} from "./verify-permanent-staging-worker-bootstrap-prerequisites.js";

export const STAGING_ACTIVATION_RECONCILIATION_SCHEMA =
  "pintpath-automatic-maintenance-worker-fence-activation-reconciliation/v1" as const;

const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const REPOSITORY = "blackmagic30/Beer";
const ORIGIN = "https://beer-staging.up.railway.app";
const BOUNDARY_POLICY_PATH = "ops/railway/production-staging-mutation-policy.json";
const GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const TOKEN_PATTERN = /^[^\r\n\0]{16,4096}$/;
const MAXIMUM_BYTES = 1024 * 1024;
const ROUTES = ["/health", "/startup", "/ready"] as const;

type MetadataPart = NonNullable<ReturnType<
  typeof automaticMaintenanceWorkerFenceInternals.metadataPart
>>;
type DeploymentPart = NonNullable<ReturnType<
  typeof automaticMaintenanceWorkerFenceInternals.deploymentPart
>>;
type ProviderSnapshot = MetadataPart & { readonly deployment: DeploymentPart };

interface RuntimeProof {
  readonly required: true;
  readonly observed: true;
  readonly pollRounds: number;
  readonly expectedSourceSha: string;
  readonly expectedAutomaticMaintenance: {
    readonly enabled: true;
    readonly candidateBound: true;
  };
  readonly deploymentIdSha256: string;
  readonly responseSha256s: Readonly<Record<(typeof ROUTES)[number], string>>;
}

interface BoundaryEvidence {
  readonly passed: boolean;
  readonly receiptSha256: string | null;
}

interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  reviewedAuthorityExact: boolean;
  activationPrerequisitesExact: boolean;
  tokenScopeExact: boolean;
  mutationCredentialsAbsent: boolean;
  boundaryPreflightExact: boolean;
  exactActivatedStateBefore: boolean;
  runtimeActivatedBefore: boolean;
  durableObservationExact: boolean;
  repositoryReasserted: boolean;
  providerReasserted: boolean;
  runtimeReasserted: boolean;
  noProviderWriteAttempted: boolean;
  postflightAttempted: boolean;
  exactActivatedStateAfter: boolean;
  providerStateUnchanged: boolean;
  collateralVariablesUnchanged: boolean;
  runtimeActivatedAfter: boolean;
  boundaryPostflightExact: boolean;
  terminalEvidenceExact: boolean;
}

interface Arguments {
  readonly candidateSha: string;
  readonly bootstrapPath: "healthy-legacy" | "cold-dead";
  readonly priorActivateRunId: string;
  readonly prerequisitesVerificationFile: string;
  readonly reviewedAuthorityFile: string;
  readonly evidenceDirectory: string;
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly readState: () => Promise<ProviderSnapshot | null>;
  readonly probeRuntime: (
    snapshot: ProviderSnapshot,
    candidateSha: string,
  ) => Promise<RuntimeProof | null>;
  readonly boundaryCheck: () => Promise<BoundaryEvidence>;
  readonly reassertRepositoryState: (cwd: string, candidateSha: string) => boolean;
  readonly readPrivateEvidence: (filename: string) => string;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalIsoTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

function argumentsExact(argv: readonly string[]): Arguments | null {
  if (argv.length !== 12) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || !key.startsWith("--") || values.has(key)) return null;
    values.set(key, value);
  }
  const allowed = [
    "--candidate-sha",
    "--bootstrap-path",
    "--prior-activate-run-id",
    "--prerequisites-verification-file",
    "--reviewed-authority-file",
    "--evidence-dir",
  ];
  if ([...values.keys()].some((key) => !allowed.includes(key))) return null;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const bootstrapPath = values.get("--bootstrap-path") ?? "";
  const priorActivateRunId = values.get("--prior-activate-run-id") ?? "";
  const prerequisitesVerificationFile =
    values.get("--prerequisites-verification-file") ?? "";
  const reviewedAuthorityFile = values.get("--reviewed-authority-file") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  if (!SHA_PATTERN.test(candidateSha) ||
    !["healthy-legacy", "cold-dead"].includes(bootstrapPath) ||
    !RUN_ID_PATTERN.test(priorActivateRunId) ||
    !path.isAbsolute(prerequisitesVerificationFile) ||
    path.basename(prerequisitesVerificationFile) !== "prerequisites-verification.json" ||
    !path.isAbsolute(reviewedAuthorityFile) ||
    path.basename(reviewedAuthorityFile) !== "reviewed-authority.json" ||
    !path.isAbsolute(evidenceDirectory)) return null;
  return {
    candidateSha,
    bootstrapPath: bootstrapPath as Arguments["bootstrapPath"],
    priorActivateRunId,
    prerequisitesVerificationFile,
    reviewedAuthorityFile,
    evidenceDirectory,
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error("provider_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAXIMUM_BYTES) throw new Error("provider_response_invalid");
    chunks.push(next.value);
  }
  if (!response.ok) throw new Error("provider_response_invalid");
  const value = JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown;
  if (record(value) && Object.hasOwn(value, "errors")) {
    throw new Error("provider_response_invalid");
  }
  return value;
}

async function railwayCall(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  if (!TOKEN_PATTERN.test(token)) throw new Error("token_invalid");
  return boundedJson(await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Project-Access-Token": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  }));
}

async function readProviderSnapshot(
  fetchImpl: typeof fetch,
  token: string,
): Promise<ProviderSnapshot | null> {
  try {
    const metadata = automaticMaintenanceWorkerFenceInternals.metadataPart(
      await railwayCall(
        fetchImpl,
        token,
        AUTOMATIC_MAINTENANCE_WORKER_FENCE_METADATA_QUERY,
        { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID, serviceId: SERVICE_ID },
      ),
      ENVIRONMENT_ID,
    );
    if (!metadata) return null;
    const deployment = automaticMaintenanceWorkerFenceInternals.deploymentPart(
      await railwayCall(
        fetchImpl,
        token,
        AUTOMATIC_MAINTENANCE_WORKER_FENCE_DEPLOYMENT_QUERY,
        { deploymentId: metadata.latestDeployment.id },
      ),
      metadata.latestDeployment.id,
    );
    return deployment && deployment.environmentId === ENVIRONMENT_ID &&
        deployment.snapshotId === metadata.latestDeployment.snapshotId
      ? { ...metadata, deployment }
      : null;
  } catch {
    return null;
  }
}

async function probeRuntime(
  fetchImpl: typeof fetch,
  snapshot: ProviderSnapshot,
  candidateSha: string,
): Promise<RuntimeProof | null> {
  const responseSha256s = {} as Record<(typeof ROUTES)[number], string>;
  for (const route of ROUTES) {
    try {
      const response = await fetchImpl(`${ORIGIN}${route}`, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;
      const source = await response.text();
      if (Buffer.byteLength(source) > MAXIMUM_BYTES) return null;
      const runtime =
        parseRailwayApplicationDeploymentAttestationRuntimeResponse(route, source);
      if (!runtime || runtime.deployment.commitSha !== candidateSha ||
        runtime.deployment.projectIdSha256 !==
          railwayDeploymentIdentityIdSha256("project", PROJECT_ID) ||
        runtime.deployment.environmentIdSha256 !==
          railwayDeploymentIdentityIdSha256("environment", ENVIRONMENT_ID) ||
        runtime.deployment.serviceIdSha256 !==
          railwayDeploymentIdentityIdSha256("service", SERVICE_ID) ||
        runtime.deployment.deploymentIdSha256 !==
          railwayDeploymentIdentityIdSha256("deployment", snapshot.deployment.id) ||
        runtime.automaticMaintenance.enabled !== true ||
        runtime.automaticMaintenance.candidateBound !== true) return null;
      responseSha256s[route] = sha256(source);
    } catch {
      return null;
    }
  }
  const deploymentIdSha256 = railwayDeploymentIdentityIdSha256(
    "deployment",
    snapshot.deployment.id,
  );
  return typeof deploymentIdSha256 !== "string" ? null : {
    required: true,
    observed: true,
    pollRounds: 1,
    expectedSourceSha: candidateSha,
    expectedAutomaticMaintenance: { enabled: true, candidateBound: true },
    deploymentIdSha256,
    responseSha256s,
  };
}

function stateExact(snapshot: ProviderSnapshot, candidateSha: string): boolean {
  const domain = snapshot.domains[0];
  return snapshot.numReplicas === 1 &&
    automaticMaintenanceWorkerFenceInternals.soleHealthyCandidate(
      snapshot,
      candidateSha,
    ) &&
    automaticMaintenanceWorkerFenceInternals.targetRowsAfterExact(
      snapshot,
      snapshot,
    ) &&
    snapshot.domains.length === 1 &&
    domain?.kind === "service" &&
    domain.domain === "beer-staging.up.railway.app" &&
    domain.targetPort === 8_080;
}

function reassertRepositoryState(cwd: string, candidateSha: string): boolean {
  try {
    const run = (args: readonly string[]) => execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    execFileSync("git", [
      "fetch", "--no-tags", "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ], { cwd, stdio: ["ignore", "ignore", "ignore"] });
    return run(["rev-parse", "HEAD"]) === candidateSha &&
      run(["rev-parse", "refs/remotes/origin/main"]) === candidateSha &&
      run(["status", "--porcelain=v2", "--untracked-files=all"]) === "";
  } catch {
    return false;
  }
}

function readPrivateEvidence(filename: string): string {
  return readTrustedRegularFile(filename, {
    minBytes: 2,
    maxBytes: MAXIMUM_BYTES,
    requireOwner: true,
    requirePrivate: true,
  }).toString("utf8");
}

function writeDurable(directory: string, leaf: string, source: string): string {
  writePrivateExclusiveFile(directory, leaf, source, { requireOwner: true });
  return sha256(source);
}

function reviewedAuthorityExact(
  source: string,
  args: Arguments,
  currentRunId: string,
): boolean {
  try {
    const value = JSON.parse(source) as unknown;
    return record(value) && `${JSON.stringify(value)}\n` === source &&
      value.command === "verify-github-reviewed-candidate-authority" &&
      value.ok === true &&
      value.kind === "pintpath-github-reviewed-candidate-authority" &&
      value.repository === REPOSITORY &&
      value.candidateSha === args.candidateSha &&
      value.operation === "staging-worker-fence-reconcile-activate" &&
      value.workflowPath ===
        ".github/workflows/configure-automatic-maintenance-worker-fence.yml" &&
      value.workflowRunId === currentRunId &&
      value.workflowRunAttempt === 1 &&
      value.priorAmbiguousStagingActivateRunId === args.priorActivateRunId &&
      value.exactPriorStagingActivateCandidateRunBound === true &&
      value.secondStagingActivateVariableWritePreventedExact === true &&
      canonicalIsoTimestamp(value.runnerLossRecoveryOriginalRunCompletedAt) &&
      value.runnerLossRecoveryGraceHours === 24 &&
      value.runnerLossRecoveryWithinGraceExact === true &&
      value.reviewedAuthorityExact === true &&
      value.freshDispatchWriteGuardExact === true;
  } catch {
    return false;
  }
}

function emptyChecks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    reviewedAuthorityExact: false,
    activationPrerequisitesExact: false,
    tokenScopeExact: false,
    mutationCredentialsAbsent: false,
    boundaryPreflightExact: false,
    exactActivatedStateBefore: false,
    runtimeActivatedBefore: false,
    durableObservationExact: false,
    repositoryReasserted: false,
    providerReasserted: false,
    runtimeReasserted: false,
    noProviderWriteAttempted: true,
    postflightAttempted: false,
    exactActivatedStateAfter: false,
    providerStateUnchanged: false,
    collateralVariablesUnchanged: false,
    runtimeActivatedAfter: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
  };
}

function allChecks(checks: Checks): boolean {
  return Object.values(checks).every((value) => value === true);
}

export async function runPermanentStagingActivationReconciliationProbe(
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
    readState: () => readProviderSnapshot(
      dependencies.fetchImpl,
      dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "",
    ),
    probeRuntime: (snapshot, candidateSha) => probeRuntime(
      dependencies.fetchImpl,
      snapshot,
      candidateSha,
    ),
    boundaryCheck: async () => {
      let output = "";
      const code = await runRailwayMutationBoundaryCheck({
        argv: ["--policy", BOUNDARY_POLICY_PATH],
        env: dependencies.env,
        fetchImpl: dependencies.fetchImpl,
        writeOutput: (value) => { output += value; },
      });
      return { passed: code === 0, receiptSha256: output ? sha256(output) : null };
    },
    reassertRepositoryState,
    readPrivateEvidence,
    writeDurable,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const startedAt = new Date(dependencies.now()).toISOString();
  const args = argumentsExact(dependencies.argv);
  const checks = emptyChecks();
  let before: ProviderSnapshot | null = null;
  let after: ProviderSnapshot | null = null;
  let beforeRuntime: RuntimeProof | null = null;
  let afterRuntime: RuntimeProof | null = null;
  let reviewedAuthoritySha256: string | null = null;
  let prerequisitesVerificationSha256: string | null = null;
  let observationSha256: string | null = null;
  let terminalSha256: string | null = null;
  let boundaryBefore: BoundaryEvidence = { passed: false, receiptSha256: null };
  let boundaryAfter: BoundaryEvidence = { passed: false, receiptSha256: null };
  let failureCode: string | null = null;
  let outcome: "reconciled_activated_after_runner_loss" | "probe_failed" =
    "probe_failed";
  try {
    checks.policyExact = automaticMaintenanceWorkerFenceInternals.policyExact(
      dependencies.cwd,
    );
    if (!args || !checks.policyExact) throw new Error("policy_or_arguments_invalid");
    checks.githubAuthorityExact = dependencies.env.GITHUB_ACTIONS === "true" &&
      dependencies.env.GITHUB_REPOSITORY === REPOSITORY &&
      dependencies.env.GITHUB_REF === "refs/heads/main" &&
      dependencies.env.GITHUB_SHA === args.candidateSha &&
      dependencies.env.GITHUB_RUN_ATTEMPT === "1" &&
      dependencies.env.PINTPATH_PROTECTED_ENVIRONMENT ===
        "permanent-staging-provider-mutation" &&
      dependencies.env.PINTPATH_AUTOMATIC_MAINTENANCE_CONFIRMATION ===
        `RECONCILE_ACTIVATE_AUTOMATIC_MAINTENANCE_IN_PERMANENT_STAGING_FOR_${args.candidateSha}`;
    if (!checks.githubAuthorityExact) throw new Error("authority_invalid");
    const currentRunId = dependencies.env.GITHUB_RUN_ID ?? "";
    const reviewedSource = dependencies.readPrivateEvidence(args.reviewedAuthorityFile);
    reviewedAuthoritySha256 = sha256(reviewedSource);
    checks.reviewedAuthorityExact = reviewedAuthorityExact(
      reviewedSource,
      args,
      currentRunId,
    );
    if (!checks.reviewedAuthorityExact) throw new Error("reviewed_authority_invalid");
    const prerequisitesSource = dependencies.readPrivateEvidence(
      args.prerequisitesVerificationFile,
    );
    prerequisitesVerificationSha256 = sha256(prerequisitesSource);
    const prerequisites = parseStagingWorkerBootstrapPrerequisitesVerification(
      prerequisitesSource,
      {
        operation: "reconcile-activate",
        bootstrapPath: args.bootstrapPath,
        candidateSha: args.candidateSha,
        currentRunId,
        now: new Date(dependencies.now()),
      },
    );
    checks.activationPrerequisitesExact =
      prerequisites.prerequisites.length === 4 &&
      prerequisites.expectedDeploymentSha === null;
    if (!checks.activationPrerequisitesExact) throw new Error("prerequisites_invalid");
    const metadata = dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    const production =
      dependencies.env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? "";
    checks.mutationCredentialsAbsent = TOKEN_PATTERN.test(metadata) &&
      TOKEN_PATTERN.test(production) && metadata !== production &&
      (dependencies.env.PINTPATH_RAILWAY_STAGING_VARIABLE_TOKEN ?? "") === "" &&
      (dependencies.env.PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN ?? "") === "" &&
      (dependencies.env.PINTPATH_RAILWAY_STAGING_SCALE_TOKEN ?? "") === "" &&
      (dependencies.env.RAILWAY_TOKEN ?? "") === "";
    if (!checks.mutationCredentialsAbsent) throw new Error("token_invalid");
    checks.tokenScopeExact = automaticMaintenanceWorkerFenceInternals.tokenScopeExact(
      await railwayCall(
        dependencies.fetchImpl,
        metadata,
        AUTOMATIC_MAINTENANCE_WORKER_FENCE_SCOPE_QUERY,
        {},
      ),
      ENVIRONMENT_ID,
    );
    if (!checks.tokenScopeExact) throw new Error("token_scope_invalid");
    boundaryBefore = await dependencies.boundaryCheck();
    checks.boundaryPreflightExact = boundaryBefore.passed &&
      boundaryBefore.receiptSha256 !== null;
    if (!checks.boundaryPreflightExact) throw new Error("boundary_invalid");
    before = await dependencies.readState();
    checks.exactActivatedStateBefore = before !== null &&
      stateExact(before, args.candidateSha);
    beforeRuntime = before === null ? null :
      await dependencies.probeRuntime(before, args.candidateSha);
    checks.runtimeActivatedBefore = beforeRuntime !== null;
    if (!checks.exactActivatedStateBefore || !checks.runtimeActivatedBefore) {
      throw new Error("activated_state_invalid");
    }
    const observation = canonical({
      schemaVersion:
        "pintpath-automatic-maintenance-worker-fence-activation-reconciliation-observation/v1",
      policySha256: AUTOMATIC_MAINTENANCE_WORKER_FENCE_POLICY_SHA256,
      operation: "reconcile-activate",
      candidateSha: args.candidateSha,
      bootstrapPath: args.bootstrapPath,
      priorAmbiguousActivateRunId: args.priorActivateRunId,
      reviewedAuthoritySha256,
      prerequisitesVerificationSha256,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      providerBeforeSha256: sha256(canonical(before)),
      boundaryPreflightReceiptSha256: boundaryBefore.receiptSha256,
      providerMutationAllowed: false,
      variableMutationCredentialAllowed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    observationSha256 = dependencies.writeDurable(
      args.evidenceDirectory,
      "activation-reconciliation-observation.json",
      observation,
    );
    checks.durableObservationExact = observationSha256 === sha256(observation);
    checks.repositoryReasserted = dependencies.reassertRepositoryState(
      dependencies.cwd,
      args.candidateSha,
    );
    if (!checks.durableObservationExact || !checks.repositoryReasserted) {
      throw new Error("observation_invalid");
    }
    const reasserted = await dependencies.readState();
    checks.providerReasserted = reasserted !== null &&
      canonical(reasserted) === canonical(before);
    checks.runtimeReasserted = reasserted !== null &&
      await dependencies.probeRuntime(reasserted, args.candidateSha) !== null;
    if (!checks.providerReasserted || !checks.runtimeReasserted) {
      throw new Error("state_drift");
    }
    checks.postflightAttempted = true;
    after = await dependencies.readState();
    checks.exactActivatedStateAfter = after !== null &&
      stateExact(after, args.candidateSha);
    checks.providerStateUnchanged = after !== null &&
      canonical(after) === canonical(before);
    checks.collateralVariablesUnchanged = after !== null &&
      canonical(automaticMaintenanceWorkerFenceInternals.otherRows(after)) ===
        canonical(automaticMaintenanceWorkerFenceInternals.otherRows(before!));
    afterRuntime = after === null ? null :
      await dependencies.probeRuntime(after, args.candidateSha);
    checks.runtimeActivatedAfter = afterRuntime !== null;
    boundaryAfter = await dependencies.boundaryCheck();
    checks.boundaryPostflightExact = boundaryAfter.passed &&
      boundaryAfter.receiptSha256 !== null;
    if (!Object.entries(checks)
      .filter(([name]) => name !== "terminalEvidenceExact")
      .every(([, value]) => value === true)) throw new Error("reconciliation_invalid");
    outcome = "reconciled_activated_after_runner_loss";
  } catch (error) {
    failureCode = error instanceof Error ? error.message : "unexpected_failure";
  }

  if (outcome === "reconciled_activated_after_runner_loss" && args && before &&
    after && beforeRuntime && afterRuntime) {
    const terminal = canonical({
      schemaVersion: STAGING_ACTIVATION_RECONCILIATION_SCHEMA,
      executorState: AUTOMATIC_MAINTENANCE_WORKER_FENCE_EXECUTOR_STATE,
      operation: "activate",
      target: "permanent-staging",
      outcome,
      failureCode: null,
      candidateSha: args.candidateSha,
      startedAt,
      completedAt: new Date(dependencies.now()).toISOString(),
      attempts: 0,
      retryAllowed: false,
      observationSha256,
      prerequisitesVerificationSha256,
      runnerLossReconciliation: {
        priorAmbiguousActivateRunId: args.priorActivateRunId,
        reviewedAuthoritySha256,
        variableMutationCredentialPresent: false,
        providerWriteAttempted: false,
      },
      providerEvidence: {
        providerBeforeSha256: sha256(canonical(before)),
        providerAfterSha256: sha256(canonical(after)),
        deploymentBeforeIdSha256: railwayDeploymentIdentityIdSha256(
          "deployment",
          before.deployment.id,
        ),
        deploymentAfterIdSha256: railwayDeploymentIdentityIdSha256(
          "deployment",
          after.deployment.id,
        ),
        sourceBeforeSha: before.deployment.commitHash,
        sourceAfterSha: after.deployment.commitHash,
        topologyBeforeSha256: sha256(
          automaticMaintenanceWorkerFenceInternals.topologyCanonical(before),
        ),
        topologyAfterSha256: sha256(
          automaticMaintenanceWorkerFenceInternals.topologyCanonical(after),
        ),
        collateralVariablesBeforeSha256: sha256(canonical(
          automaticMaintenanceWorkerFenceInternals.otherRows(before),
        )),
        collateralVariablesAfterSha256: sha256(canonical(
          automaticMaintenanceWorkerFenceInternals.otherRows(after),
        )),
      },
      runtimeEvidence: {
        before: beforeRuntime,
        after: afterRuntime,
      },
      mutationBoundaryEvidence: {
        preflightReceiptSha256: boundaryBefore.receiptSha256,
        postflightReceiptSha256: boundaryAfter.receiptSha256,
      },
      checks: { ...checks, terminalEvidenceExact: true },
      nextRequiredProof: "ACTIVE_DEPLOYMENT_AND_SCALE_EVIDENCE",
      normalActivationMutationReceiptClaimed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    try {
      terminalSha256 = dependencies.writeDurable(
        args.evidenceDirectory,
        "automatic-maintenance-worker-fence-terminal.json",
        terminal,
      );
      checks.terminalEvidenceExact = terminalSha256 === sha256(terminal);
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
      "pintpath-automatic-maintenance-worker-fence-activation-reconciliation-output/v1",
    operation: "reconcile-activate",
    outcome,
    failureCode,
    candidateSha: args?.candidateSha ?? null,
    priorAmbiguousActivateRunId: args?.priorActivateRunId ?? null,
    attempts: 0,
    reviewedAuthoritySha256,
    prerequisitesVerificationSha256,
    observationSha256,
    terminalSha256,
    checks,
  })}\n`);
  return outcome === "reconciled_activated_after_runner_loss" && allChecks(checks)
    ? 0
    : 1;
}

if (process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPermanentStagingActivationReconciliationProbe();
}
