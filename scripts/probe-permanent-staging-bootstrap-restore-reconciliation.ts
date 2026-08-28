import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseRailwayApplicationDeploymentAttestationEmptyPatchResponse,
  parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse,
  parseRailwayApplicationDeploymentAttestationRuntimeResponse,
  type RailwayApplicationDeploymentAttestationProviderSnapshot,
} from "../src/lib/railway-application-deployment-attestation.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";
import {
  canonical,
  defaultBoundaryCheck,
  railwayCall,
  readOnlyTokensExact,
  readPrivateEvidence,
  reassertRepositoryState,
  sha256,
  tokenScopeExact,
  writeDurable,
  type BoundaryEvidence,
} from "./lib/permanent-staging-cold-recovery.js";
import {
  parseStagingWorkerBootstrapPrerequisitesVerification,
  type BootstrapConsumerOperation,
  type BootstrapPath,
  type StagingWorkerBootstrapPrerequisitesVerification,
} from "./verify-permanent-staging-worker-bootstrap-prerequisites.js";

export const STAGING_BOOTSTRAP_RESTORE_RECONCILIATION_SCHEMA =
  "pintpath-permanent-staging-bootstrap-restore-reconciliation/v1" as const;

const REPOSITORY = "blackmagic30/Beer";
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const STAGING_ORIGIN = "https://beer-staging.up.railway.app";
const STAGING_DOMAIN = "beer-staging.up.railway.app";
const APPLICATION_TARGET_PORT = 8_080;
const SCALE_POLICY_PATH = "ops/railway/permanent-staging-scale-evidence-policy.json";
const SCALE_POLICY_SHA256 =
  "164d53a5bccff4a861c8568abebe5caa06352f64245ac7e734e55c056c2be608";
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const MAXIMUM_EVIDENCE_BYTES = 1024 * 1024;
const MAXIMUM_RUNTIME_BYTES = 1024 * 1024;
const MAXIMUM_PROVIDER_ROUNDS = 61;
const MAXIMUM_RUNTIME_ROUNDS = 61;
const RECONCILIATION_INTERVAL_MS = 5_000;
const RUNTIME_ROUTES = ["/health", "/startup", "/ready"] as const;

export const STAGING_BOOTSTRAP_RESTORE_EMPTY_PATCH_QUERY =
  `query PintPathStagingBootstrapRestoreEmptyPatch(
  $projectId: String!
  $environmentId: String!
) {
  environment(id:$environmentId,projectId:$projectId) { id }
  staged: environmentStagedChanges(environmentId:$environmentId) {
    environmentId
    patch(decryptVariables:false)
  }
}`;

export const STAGING_BOOTSTRAP_RESTORE_DISCOVERY_QUERY =
  `query PintPathStagingBootstrapRestoreDiscovery(
  $environmentId: String!
  $serviceId: String!
) {
  serviceInstance(environmentId:$environmentId,serviceId:$serviceId) {
    latestDeployment { id }
  }
}`;

export const STAGING_BOOTSTRAP_RESTORE_SNAPSHOT_QUERY =
  `query PintPathStagingBootstrapRestoreSnapshot(
  $environmentId: String!
  $serviceId: String!
  $deploymentId: String!
) {
  serviceInstance(environmentId:$environmentId,serviceId:$serviceId) {
    id
    serviceId
    environmentId
    numReplicas
    latestDeployment { id status deploymentStopped snapshotId }
    activeDeployments { id status deploymentStopped }
    domains {
      serviceDomains { id domain targetPort }
      customDomains { id domain targetPort }
    }
  }
  deployment(id:$deploymentId) {
    id
    projectId
    environmentId
    serviceId
    snapshotId
    meta
  }
}`;

type RuntimeRoute = (typeof RUNTIME_ROUTES)[number];

interface Arguments {
  readonly candidateSha: string;
  readonly expectedDeploymentSha: string;
  readonly bootstrapPath: BootstrapPath;
  readonly priorRestoreRunId: string;
  readonly prerequisitesVerificationFile: string;
  readonly reviewedAuthorityFile: string;
  readonly evidenceDirectory: string;
}

interface RestoreState {
  readonly patchEmpty: true;
  readonly snapshot: RailwayApplicationDeploymentAttestationProviderSnapshot;
}

interface RuntimeProof {
  readonly observed: boolean;
  readonly pollRounds: number;
  readonly responseSha256s: Readonly<Record<RuntimeRoute, string | null>>;
}

interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  reviewedAuthorityExact: boolean;
  prerequisitesExact: boolean;
  tokenScopeExact: boolean;
  scaleCredentialAbsent: boolean;
  boundaryPreflightExact: boolean;
  exactCandidateOneBefore: boolean;
  fencedDeploymentIdentityExact: boolean;
  runtimeBeforeExact: boolean;
  durableObservationExact: boolean;
  repositoryBeforeExact: boolean;
  repositoryAfterExact: boolean;
  repositoryReasserted: boolean;
  providerReasserted: boolean;
  runtimeReasserted: boolean;
  noProviderWriteAttempted: boolean;
  postflightAttempted: boolean;
  exactCandidateOneAfter: boolean;
  deploymentAndTopologyUnchanged: boolean;
  runtimeAfterExact: boolean;
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
  readonly readState: (token: string) => Promise<RestoreState | null>;
  readonly probeRuntime: (
    candidateSha: string,
    deploymentId: string,
  ) => Promise<RuntimeProof>;
  readonly readPrivateEvidence: (filename: string) => string;
  readonly parsePrerequisites: (
    source: string,
    expected: {
      readonly operation: BootstrapConsumerOperation;
      readonly bootstrapPath: BootstrapPath;
      readonly candidateSha: string;
      readonly currentRunId: string;
      readonly now: Date;
    },
  ) => StagingWorkerBootstrapPrerequisitesVerification;
  readonly reassertRepositoryState: (cwd: string, candidateSha: string) => boolean;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
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

function emptyChecks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    reviewedAuthorityExact: false,
    prerequisitesExact: false,
    tokenScopeExact: false,
    scaleCredentialAbsent: false,
    boundaryPreflightExact: false,
    exactCandidateOneBefore: false,
    fencedDeploymentIdentityExact: false,
    runtimeBeforeExact: false,
    durableObservationExact: false,
    repositoryBeforeExact: false,
    repositoryAfterExact: false,
    repositoryReasserted: false,
    providerReasserted: false,
    runtimeReasserted: false,
    noProviderWriteAttempted: true,
    postflightAttempted: false,
    exactCandidateOneAfter: false,
    deploymentAndTopologyUnchanged: false,
    runtimeAfterExact: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
  };
}

function allChecks(checks: Checks): boolean {
  return Object.values(checks).every((check) => check === true);
}

function exactAbsoluteFile(value: string, leaf: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value &&
    path.basename(value) === leaf;
}

function parseArguments(argv: readonly string[]): Arguments | null {
  if (argv.length !== 14) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || !key.startsWith("--") || values.has(key)) return null;
    values.set(key, value);
  }
  const allowed = [
    "--candidate-sha",
    "--expected-deployment-sha",
    "--bootstrap-path",
    "--prior-restore-run-id",
    "--prerequisites-verification-file",
    "--reviewed-authority-file",
    "--evidence-dir",
  ];
  if ([...values.keys()].some((key) => !allowed.includes(key))) return null;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const expectedDeploymentSha = values.get("--expected-deployment-sha") ?? "";
  const bootstrapPath = values.get("--bootstrap-path") as BootstrapPath;
  const priorRestoreRunId = values.get("--prior-restore-run-id") ?? "";
  const prerequisitesVerificationFile =
    values.get("--prerequisites-verification-file") ?? "";
  const reviewedAuthorityFile = values.get("--reviewed-authority-file") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  if (!SHA_PATTERN.test(candidateSha) || expectedDeploymentSha !== candidateSha ||
    (bootstrapPath !== "healthy-legacy" && bootstrapPath !== "cold-dead") ||
    !RUN_ID_PATTERN.test(priorRestoreRunId) ||
    !exactAbsoluteFile(
      prerequisitesVerificationFile,
      "prerequisites-verification.json",
    ) ||
    !exactAbsoluteFile(reviewedAuthorityFile, "reviewed-authority.json") ||
    !path.isAbsolute(evidenceDirectory) || path.resolve(evidenceDirectory) !== evidenceDirectory) {
    return null;
  }
  return {
    candidateSha,
    expectedDeploymentSha,
    bootstrapPath,
    priorRestoreRunId,
    prerequisitesVerificationFile,
    reviewedAuthorityFile,
    evidenceDirectory,
  };
}

function policyExact(cwd: string): boolean {
  try {
    return sha256(fs.readFileSync(path.resolve(cwd, SCALE_POLICY_PATH))) ===
      SCALE_POLICY_SHA256;
  } catch {
    return false;
  }
}

function githubAuthorityExact(
  env: Readonly<Record<string, string | undefined>>,
  candidateSha: string,
): boolean {
  return env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_REPOSITORY === REPOSITORY &&
    env.GITHUB_REF === "refs/heads/main" &&
    env.GITHUB_SHA === candidateSha &&
    env.GITHUB_RUN_ATTEMPT === "1" &&
    RUN_ID_PATTERN.test(env.GITHUB_RUN_ID ?? "") &&
    env.PINTPATH_PROTECTED_ENVIRONMENT === "permanent-staging-scale-evidence" &&
    env.PINTPATH_STAGING_WORKER_BOOTSTRAP_CONFIRMATION ===
      `RECONCILE_PERMANENT_STAGING_WORKER_BOOTSTRAP_AT_ONE_FOR_${candidateSha}`;
}

function parseReviewedAuthority(
  source: string,
  candidateSha: string,
  currentRunId: string,
  priorRestoreRunId: string,
): boolean {
  try {
    const value = JSON.parse(source) as unknown;
    return record(value) && `${JSON.stringify(value)}\n` === source &&
      value.command === "verify-github-reviewed-candidate-authority" &&
      value.ok === true &&
      value.kind === "pintpath-github-reviewed-candidate-authority" &&
      value.repository === REPOSITORY &&
      value.candidateSha === candidateSha &&
      value.operation === "staging-worker-bootstrap-reconcile-restore" &&
      value.workflowPath ===
        ".github/workflows/bootstrap-permanent-staging-worker-fence.yml" &&
      value.workflowRunId === currentRunId &&
      value.workflowRunAttempt === 1 &&
      value.priorAmbiguousStagingRestoreRunId === priorRestoreRunId &&
      value.exactPriorStagingRestoreCandidateRunBound === true &&
      value.secondStagingRestoreScaleWritePreventedExact === true &&
      canonicalIsoTimestamp(value.runnerLossRecoveryOriginalRunCompletedAt) &&
      value.runnerLossRecoveryGraceHours === 24 &&
      value.runnerLossRecoveryWithinGraceExact === true &&
      value.reviewedAuthorityExact === true &&
      value.freshDispatchWriteGuardExact === true;
  } catch {
    return false;
  }
}

function stateExact(
  state: RestoreState | null,
  candidateSha: string,
): state is RestoreState {
  if (!state || !state.patchEmpty) return false;
  const snapshot = state.snapshot;
  const domain = snapshot.domains[0];
  const active = snapshot.activeDeployments[0];
  return snapshot.serviceId === SERVICE_ID &&
    snapshot.environmentId === ENVIRONMENT_ID &&
    snapshot.numReplicas === 1 &&
    snapshot.latestDeployment.id === snapshot.deployment.id &&
    snapshot.latestDeployment.status === "SUCCESS" &&
    snapshot.latestDeployment.deploymentStopped === false &&
    snapshot.latestDeployment.snapshotId === snapshot.deployment.snapshotId &&
    snapshot.activeDeployments.length === 1 &&
    active?.id === snapshot.deployment.id &&
    active.status === "SUCCESS" &&
    active.deploymentStopped === false &&
    snapshot.deployment.projectId === PROJECT_ID &&
    snapshot.deployment.environmentId === ENVIRONMENT_ID &&
    snapshot.deployment.serviceId === SERVICE_ID &&
    snapshot.deployment.commitHash === candidateSha &&
    snapshot.deployment.patchId === null &&
    snapshot.domains.length === 1 &&
    domain?.kind === "service" &&
    domain.domain === STAGING_DOMAIN &&
    domain.targetPort === APPLICATION_TARGET_PORT;
}

function stateCanonical(state: RestoreState): string {
  return canonical(state);
}

function topologyCanonical(state: RestoreState): string {
  return canonical({
    serviceInstanceId: state.snapshot.serviceInstanceId,
    serviceId: state.snapshot.serviceId,
    environmentId: state.snapshot.environmentId,
    numReplicas: state.snapshot.numReplicas,
    latestDeployment: state.snapshot.latestDeployment,
    activeDeployments: state.snapshot.activeDeployments,
    domains: state.snapshot.domains,
    deployment: state.snapshot.deployment,
  });
}

function parseDiscovery(value: unknown): string | null {
  if (!record(value) || !record(value.data) || !record(value.data.serviceInstance) ||
    !record(value.data.serviceInstance.latestDeployment) ||
    typeof value.data.serviceInstance.latestDeployment.id !== "string") return null;
  return value.data.serviceInstance.latestDeployment.id;
}

async function readState(
  fetchImpl: typeof fetch,
  token: string,
): Promise<RestoreState | null> {
  try {
    const patch = parseRailwayApplicationDeploymentAttestationEmptyPatchResponse(
      JSON.stringify(await railwayCall(
        fetchImpl,
        token,
        STAGING_BOOTSTRAP_RESTORE_EMPTY_PATCH_QUERY,
        { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID },
      )),
    );
    const deploymentId = parseDiscovery(await railwayCall(
      fetchImpl,
      token,
      STAGING_BOOTSTRAP_RESTORE_DISCOVERY_QUERY,
      { environmentId: ENVIRONMENT_ID, serviceId: SERVICE_ID },
    ));
    if (!patch || patch.environmentId !== ENVIRONMENT_ID || !deploymentId) return null;
    const snapshot = parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse(
      JSON.stringify(await railwayCall(
        fetchImpl,
        token,
        STAGING_BOOTSTRAP_RESTORE_SNAPSHOT_QUERY,
        {
          environmentId: ENVIRONMENT_ID,
          serviceId: SERVICE_ID,
          deploymentId,
        },
      )),
    );
    return snapshot ? { patchEmpty: true, snapshot } : null;
  } catch {
    return null;
  }
}

async function boundedBody(response: Response): Promise<string> {
  if (response.body === null) throw new Error("runtime_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > MAXIMUM_RUNTIME_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("runtime_response_invalid");
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

async function probeRuntime(
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
  candidateSha: string,
  deploymentId: string,
): Promise<RuntimeProof> {
  for (let round = 1; round <= MAXIMUM_RUNTIME_ROUNDS; round += 1) {
    const hashes: Record<RuntimeRoute, string | null> = {
      "/health": null,
      "/startup": null,
      "/ready": null,
    };
    await Promise.all(RUNTIME_ROUTES.map(async (route) => {
      try {
        const response = await fetchImpl(`${STAGING_ORIGIN}${route}`, {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        const source = await boundedBody(response);
        if (!response.ok) return;
        const value = parseRailwayApplicationDeploymentAttestationRuntimeResponse(
          route,
          source,
        );
        if (!value || value.deployment.commitSha !== candidateSha ||
          value.deployment.projectIdSha256 !==
            railwayDeploymentIdentityIdSha256("project", PROJECT_ID) ||
          value.deployment.environmentIdSha256 !==
            railwayDeploymentIdentityIdSha256("environment", ENVIRONMENT_ID) ||
          value.deployment.serviceIdSha256 !==
            railwayDeploymentIdentityIdSha256("service", SERVICE_ID) ||
          value.deployment.deploymentIdSha256 !==
            railwayDeploymentIdentityIdSha256("deployment", deploymentId) ||
          value.automaticMaintenance.enabled !== false ||
          value.automaticMaintenance.candidateBound !== true) return;
        hashes[route] = sha256(source);
      } catch {
        // The bounded fixed-round reconciliation below handles transient failures.
      }
    }));
    if (RUNTIME_ROUTES.every((route) => SHA256_PATTERN.test(hashes[route] ?? ""))) {
      return { observed: true, pollRounds: round, responseSha256s: hashes };
    }
    if (round < MAXIMUM_RUNTIME_ROUNDS) await sleep(RECONCILIATION_INTERVAL_MS);
  }
  return {
    observed: false,
    pollRounds: MAXIMUM_RUNTIME_ROUNDS,
    responseSha256s: { "/health": null, "/startup": null, "/ready": null },
  };
}

async function waitForExactState(
  dependencies: Dependencies,
  token: string,
  candidateSha: string,
): Promise<RestoreState | null> {
  for (let round = 1; round <= MAXIMUM_PROVIDER_ROUNDS; round += 1) {
    const state = await dependencies.readState(token);
    if (stateExact(state, candidateSha)) return state;
    if (round < MAXIMUM_PROVIDER_ROUNDS) {
      await dependencies.sleep(RECONCILIATION_INTERVAL_MS);
    }
  }
  return null;
}

function prerequisitesExact(
  value: StagingWorkerBootstrapPrerequisitesVerification,
  args: Arguments,
): boolean {
  const expectedKinds = args.bootstrapPath === "cold-dead"
    ? ["cold-prepare", "cold-quiesce", "fenced-deployment"]
    : ["prepare", "quiesce", "fenced-deployment"];
  return value.operation === "reconcile-restore" &&
    value.bootstrapPath === args.bootstrapPath &&
    value.candidateSha === args.candidateSha &&
    value.expectedDeploymentSha === args.candidateSha &&
    value.prerequisites.length === expectedKinds.length &&
    value.prerequisites.every((item, index) => item.kind === expectedKinds[index]) &&
    value.prerequisites[2]?.receipt.sourceSha === args.candidateSha &&
    SHA256_PATTERN.test(value.prerequisites[2]?.receipt.deploymentIdSha256 ?? "");
}

export async function runPermanentStagingBootstrapRestoreReconciliationProbe(
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
    readState: (token) => readState(dependencies.fetchImpl, token),
    probeRuntime: (candidateSha, deploymentId) => probeRuntime(
      dependencies.fetchImpl,
      dependencies.sleep,
      candidateSha,
      deploymentId,
    ),
    readPrivateEvidence,
    parsePrerequisites: parseStagingWorkerBootstrapPrerequisitesVerification,
    reassertRepositoryState,
    writeDurable,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const startedAt = new Date(dependencies.now()).toISOString();
  const args = parseArguments(dependencies.argv);
  const checks = emptyChecks();
  let before: RestoreState | null = null;
  let after: RestoreState | null = null;
  let runtimeBefore: RuntimeProof | null = null;
  let runtimeAfter: RuntimeProof | null = null;
  let boundaryBefore: BoundaryEvidence = { passed: false, receiptSha256: null };
  let boundaryAfter: BoundaryEvidence = { passed: false, receiptSha256: null };
  let reviewedAuthoritySha256: string | null = null;
  let prerequisitesVerificationSha256: string | null = null;
  let observationSha256: string | null = null;
  let terminalSha256: string | null = null;
  let failureCode: string | null = null;
  let outcome: "reconciled_one_after_runner_loss" | "probe_failed" = "probe_failed";

  try {
    checks.policyExact = policyExact(dependencies.cwd);
    if (!args || !checks.policyExact) throw new Error("policy_or_arguments_invalid");
    checks.githubAuthorityExact = githubAuthorityExact(dependencies.env, args.candidateSha);
    if (!checks.githubAuthorityExact) throw new Error("github_authority_invalid");

    const reviewedSource = dependencies.readPrivateEvidence(args.reviewedAuthorityFile);
    reviewedAuthoritySha256 = sha256(reviewedSource);
    checks.reviewedAuthorityExact = parseReviewedAuthority(
      reviewedSource,
      args.candidateSha,
      dependencies.env.GITHUB_RUN_ID ?? "",
      args.priorRestoreRunId,
    );
    if (!checks.reviewedAuthorityExact) throw new Error("reviewed_authority_invalid");

    const prerequisitesSource = dependencies.readPrivateEvidence(
      args.prerequisitesVerificationFile,
    );
    prerequisitesVerificationSha256 = sha256(prerequisitesSource);
    const prerequisites = dependencies.parsePrerequisites(prerequisitesSource, {
      operation: "reconcile-restore",
      bootstrapPath: args.bootstrapPath,
      candidateSha: args.candidateSha,
      currentRunId: dependencies.env.GITHUB_RUN_ID ?? "",
      now: new Date(dependencies.now()),
    });
    checks.prerequisitesExact = prerequisitesExact(prerequisites, args);
    if (!checks.prerequisitesExact) throw new Error("prerequisites_invalid");

    const tokens = readOnlyTokensExact(dependencies.env);
    checks.scaleCredentialAbsent = tokens !== null;
    if (!tokens) throw new Error("token_configuration_invalid");
    checks.tokenScopeExact = tokenScopeExact(await railwayCall(
      dependencies.fetchImpl,
      tokens.metadata,
      "query PintPathStagingBootstrapRestoreScope { projectToken { projectId environmentId } }",
      {},
    ));
    if (!checks.tokenScopeExact) throw new Error("token_scope_invalid");

    checks.repositoryBeforeExact = dependencies.reassertRepositoryState(
      dependencies.cwd,
      args.candidateSha,
    );
    if (!checks.repositoryBeforeExact) throw new Error("repository_drift");

    boundaryBefore = await dependencies.boundaryCheck();
    checks.boundaryPreflightExact = boundaryBefore.passed &&
      boundaryBefore.receiptSha256 !== null;
    if (!checks.boundaryPreflightExact) throw new Error("boundary_invalid");

    before = await waitForExactState(dependencies, tokens.metadata, args.candidateSha);
    checks.exactCandidateOneBefore = before !== null;
    if (!before) throw new Error("provider_state_invalid");
    const liveDeploymentIdSha256 = railwayDeploymentIdentityIdSha256(
      "deployment",
      before.snapshot.deployment.id,
    );
    checks.fencedDeploymentIdentityExact = liveDeploymentIdSha256 !== null &&
      liveDeploymentIdSha256 ===
        prerequisites.prerequisites[2]?.receipt.deploymentIdSha256;
    if (!checks.fencedDeploymentIdentityExact) throw new Error("deployment_identity_invalid");
    runtimeBefore = await dependencies.probeRuntime(
      args.candidateSha,
      before.snapshot.deployment.id,
    );
    checks.runtimeBeforeExact = runtimeBefore.observed;
    if (!checks.runtimeBeforeExact) throw new Error("runtime_invalid");

    const observation = canonical({
      schemaVersion:
        "pintpath-permanent-staging-bootstrap-restore-reconciliation-observation/v1",
      operation: "reconcile-restore",
      candidateSha: args.candidateSha,
      bootstrapPath: args.bootstrapPath,
      priorAmbiguousRestoreRunId: args.priorRestoreRunId,
      reviewedAuthoritySha256,
      prerequisitesVerificationSha256,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      deploymentIdSha256: liveDeploymentIdSha256,
      replicasObserved: 1,
      providerBeforeSha256: sha256(stateCanonical(before)),
      boundaryPreflightReceiptSha256: boundaryBefore.receiptSha256,
      providerMutationAllowed: false,
      scaleCredentialAllowed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    observationSha256 = dependencies.writeDurable(
      args.evidenceDirectory,
      "bootstrap-staging-one-reconciliation-observation.json",
      observation,
    );
    checks.durableObservationExact = observationSha256 === sha256(observation);
    if (!checks.durableObservationExact) throw new Error("observation_invalid");

    checks.postflightAttempted = true;
    after = await waitForExactState(dependencies, tokens.metadata, args.candidateSha);
    if (!after) throw new Error("provider_drift");
    checks.providerReasserted = stateCanonical(after) === stateCanonical(before);
    checks.exactCandidateOneAfter = true;
    checks.deploymentAndTopologyUnchanged =
      topologyCanonical(after) === topologyCanonical(before);
    if (!checks.providerReasserted || !checks.exactCandidateOneAfter ||
      !checks.deploymentAndTopologyUnchanged) throw new Error("provider_drift");
    runtimeAfter = await dependencies.probeRuntime(
      args.candidateSha,
      after.snapshot.deployment.id,
    );
    checks.runtimeReasserted = runtimeAfter.observed;
    checks.runtimeAfterExact = runtimeAfter.observed;
    if (!checks.runtimeAfterExact) throw new Error("runtime_drift");
    boundaryAfter = await dependencies.boundaryCheck();
    checks.boundaryPostflightExact = boundaryAfter.passed &&
      boundaryAfter.receiptSha256 !== null;
    if (!checks.boundaryPostflightExact) throw new Error("boundary_invalid");
    checks.repositoryAfterExact = dependencies.reassertRepositoryState(
      dependencies.cwd,
      args.candidateSha,
    );
    checks.repositoryReasserted = checks.repositoryBeforeExact &&
      checks.repositoryAfterExact;
    if (!checks.repositoryReasserted) throw new Error("repository_drift");
    outcome = "reconciled_one_after_runner_loss";
  } catch (error) {
    failureCode = error instanceof Error ? error.message : "unexpected_failure";
  }

  if (outcome === "reconciled_one_after_runner_loss" && args && before && after &&
    runtimeBefore && runtimeAfter) {
    const deploymentIdSha256 = railwayDeploymentIdentityIdSha256(
      "deployment",
      before.snapshot.deployment.id,
    );
    const receipt = canonical({
      schemaVersion: STAGING_BOOTSTRAP_RESTORE_RECONCILIATION_SCHEMA,
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      operation: "restore",
      target: "permanent-staging",
      outcome,
      failureCode: null,
      candidateSha: args.candidateSha,
      sourceSha: args.candidateSha,
      bootstrapPath: args.bootstrapPath,
      startedAt,
      completedAt: new Date(dependencies.now()).toISOString(),
      replicasBefore: 1,
      replicasAfter: 1,
      attempts: 0,
      retryAllowed: false,
      observationSha256,
      prerequisitesVerificationSha256,
      runnerLossReconciliation: {
        priorAmbiguousRestoreRunId: args.priorRestoreRunId,
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
        deploymentIdSha256,
        snapshotIdSha256: sha256(before.snapshot.deployment.snapshotId),
        stateBeforeSha256: sha256(stateCanonical(before)),
        stateAfterSha256: sha256(stateCanonical(after)),
        topologyBeforeSha256: sha256(topologyCanonical(before)),
        topologyAfterSha256: sha256(topologyCanonical(after)),
        stagedPatchEmptyBefore: before.patchEmpty,
        stagedPatchEmptyAfter: after.patchEmpty,
      },
      runtimeEvidence: {
        required: true,
        expectedSourceSha: args.candidateSha,
        expectedAutomaticMaintenance: { enabled: false, candidateBound: true },
        deploymentIdSha256,
        beforePollRounds: runtimeBefore.pollRounds,
        afterPollRounds: runtimeAfter.pollRounds,
        beforeResponseSha256s: runtimeBefore.responseSha256s,
        afterResponseSha256s: runtimeAfter.responseSha256s,
      },
      repositoryEvidence: {
        beforeExact: checks.repositoryBeforeExact,
        afterExact: checks.repositoryAfterExact,
      },
      mutationBoundaryEvidence: {
        preflightReceiptSha256: boundaryBefore.receiptSha256,
        postflightReceiptSha256: boundaryAfter.receiptSha256,
      },
      checks: { ...checks, terminalEvidenceExact: true },
      nextRequiredProof: "ACTIVATE_AUTOMATIC_MAINTENANCE",
      normalZeroToOneReceiptClaimed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    if (Buffer.byteLength(receipt) <= MAXIMUM_EVIDENCE_BYTES) {
      try {
        terminalSha256 = dependencies.writeDurable(
          args.evidenceDirectory,
          "bootstrap-staging-one-receipt.json",
          receipt,
        );
        checks.terminalEvidenceExact = terminalSha256 === sha256(receipt);
      } catch {
        checks.terminalEvidenceExact = false;
      }
    }
  }
  if (!checks.terminalEvidenceExact) {
    outcome = "probe_failed";
    failureCode ??= "terminal_evidence_failed";
  }
  dependencies.writeOutput(`${JSON.stringify({
    schemaVersion:
      "pintpath-permanent-staging-bootstrap-restore-reconciliation-output/v1",
    operation: "reconcile-restore",
    outcome,
    failureCode,
    candidateSha: args?.candidateSha ?? null,
    bootstrapPath: args?.bootstrapPath ?? null,
    replicasBefore: before?.snapshot.numReplicas ?? null,
    replicasAfter: after?.snapshot.numReplicas ?? null,
    attempts: 0,
    priorAmbiguousRestoreRunId: args?.priorRestoreRunId ?? null,
    reviewedAuthoritySha256,
    prerequisitesVerificationSha256,
    observationSha256,
    terminalSha256,
    checks,
  })}\n`);
  return outcome === "reconciled_one_after_runner_loss" && allChecks(checks) ? 0 : 1;
}

export const stagingBootstrapRestoreReconciliationInternals = {
  githubAuthorityExact,
  parseArguments,
  parseReviewedAuthority,
  stateExact,
};

if (process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPermanentStagingBootstrapRestoreReconciliationProbe();
}
