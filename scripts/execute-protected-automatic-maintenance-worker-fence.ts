import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRailwayMutationBoundaryCheck } from
  "./check-railway-mutation-boundary.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";
import {
  parseProductionActivationRoleLimitPrerequisiteVerification,
  PRODUCTION_ACTIVATION_ROLE_LIMIT_PREREQUISITE_FILENAME,
  type ProductionActivationRoleLimitPrerequisiteVerification,
} from "./verify-production-maintenance-role-limit-prerequisites.js";

export const AUTOMATIC_MAINTENANCE_WORKER_FENCE_POLICY_SCHEMA =
  "pintpath-protected-automatic-maintenance-worker-fence-policy/v1" as const;
export const AUTOMATIC_MAINTENANCE_WORKER_FENCE_AUTHORITY_SCHEMA =
  "pintpath-automatic-maintenance-worker-fence-authority/v1" as const;
export const AUTOMATIC_MAINTENANCE_WORKER_FENCE_INTENT_SCHEMA =
  "pintpath-automatic-maintenance-worker-fence-intent/v1" as const;
export const AUTOMATIC_MAINTENANCE_WORKER_FENCE_TERMINAL_SCHEMA =
  "pintpath-automatic-maintenance-worker-fence-terminal/v1" as const;
export const AUTOMATIC_MAINTENANCE_WORKER_FENCE_EXECUTOR_STATE =
  "GITHUB_ENVIRONMENT_PROTECTED" as const;
export const AUTOMATIC_MAINTENANCE_WORKER_FENCE_POLICY_SHA256 =
  "260a15eb364fe6e95a40b1e15af8950f8ea6f8ccd1f3b0983ef4a39810ea57bb" as const;

const POLICY_PATH =
  "ops/railway/protected-automatic-maintenance-worker-fence-policy.json";
const BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json";
const BOUNDARY_POLICY_SHA256 =
  "9392f0c605dec43657d4d3a5a6ce40d57fe9beb70fce5ff496bb1a5f2fed3fed";
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const REPOSITORY = "blackmagic30/Beer";
const BRANCH = "main";
const WORKFLOW_PATH =
  ".github/workflows/configure-automatic-maintenance-worker-fence.yml";
const WORKFLOW_ID = "configure-automatic-maintenance-worker-fence.yml";
const RAILWAY_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const GITHUB_ENDPOINT = "https://api.github.com";
const MAX_PROVIDER_BYTES = 1_024 * 1_024;
const MAX_GITHUB_BYTES = 1_024 * 1_024;
const MAX_RUNTIME_BYTES = 1_024 * 1_024;
const MAX_EVIDENCE_BYTES = 64 * 1_024;
const MAX_HISTORY_PAGES = 10;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[^\r\n\0]{16,4096}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const VARIABLE_NAMES = Object.freeze([
  "PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED",
  "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
] as const);
const RUNTIME_ROUTES = Object.freeze([
  "/health",
  "/startup",
  "/ready",
] as const);
const TARGETS = Object.freeze({
  "permanent-staging": Object.freeze({
    environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    forbiddenEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
    publicOrigin: "https://beer-staging.up.railway.app",
    githubEnvironment: "permanent-staging-provider-mutation",
  }),
  production: Object.freeze({
    environmentId: "13dab015-df74-45c6-b26f-69323daea99a",
    forbiddenEnvironmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    publicOrigin: "https://pintpath.au",
    githubEnvironment: "production-runtime-configuration",
  }),
} as const);
const OPERATIONS = Object.freeze({
  prepare: Object.freeze({
    allowedTargets: Object.freeze(["permanent-staging"] as const),
    enabledValue: "false" as const,
    skipDeploys: true as const,
    preflightMode: "none" as const,
    postflightMode: "unchanged" as const,
    runtimeEnabled: false as const,
    runtimeCandidateBound: false as const,
    requiresRuntimeProof: false,
  }),
  fence: Object.freeze({
    allowedTargets: Object.freeze(["production"] as const),
    enabledValue: "false" as const,
    skipDeploys: true as const,
    preflightMode: "none" as const,
    postflightMode: "unchanged" as const,
    runtimeEnabled: false as const,
    runtimeCandidateBound: false as const,
    requiresRuntimeProof: false,
  }),
  activate: Object.freeze({
    allowedTargets: Object.freeze([
      "permanent-staging",
      "production",
    ] as const),
    enabledValue: "true" as const,
    skipDeploys: false as const,
    preflightMode: "healthy-candidate" as const,
    postflightMode: "healthy-candidate" as const,
    runtimeEnabled: true as const,
    runtimeCandidateBound: true as const,
    requiresRuntimeProof: true,
  }),
} as const);

export const AUTOMATIC_MAINTENANCE_WORKER_FENCE_SCOPE_QUERY =
  `query PintPathAutomaticMaintenanceWorkerFenceScope { projectToken { projectId environmentId } }`;
export const AUTOMATIC_MAINTENANCE_WORKER_FENCE_METADATA_QUERY =
  `query PintPathAutomaticMaintenanceWorkerFenceMetadata(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
) {
  environment(id:$environmentId,projectId:$projectId) {
    id
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
}`;
export const AUTOMATIC_MAINTENANCE_WORKER_FENCE_DEPLOYMENT_QUERY =
  `query PintPathAutomaticMaintenanceWorkerFenceDeployment($deploymentId: String!) {
  deployment(id:$deploymentId) {
    id
    projectId
    environmentId
    serviceId
    snapshotId
    meta
  }
}`;
export const AUTOMATIC_MAINTENANCE_WORKER_FENCE_MUTATION =
  `mutation PintPathAutomaticMaintenanceWorkerFence(
  $projectId: String!
  $serviceId: String!
  $environmentId: String!
  $variables: EnvironmentVariables!
  $skipDeploys: Boolean
) {
  variableCollectionUpsert(input:{projectId:$projectId,serviceId:$serviceId,environmentId:$environmentId,variables:$variables,skipDeploys:$skipDeploys})
}`;

type TargetName = keyof typeof TARGETS;
type Operation = keyof typeof OPERATIONS;
type RuntimeRoute = (typeof RUNTIME_ROUTES)[number];
type FailureCode =
  | "ARGUMENTS_INVALID"
  | "POLICY_INVALID"
  | "AUTHORITY_INVALID"
  | "AUTHORITY_RECEIPT_INVALID"
  | "ACTIVATION_PREREQUISITE_INVALID"
  | "TOKEN_CONFIGURATION_INVALID"
  | "TOKEN_SCOPE_INVALID"
  | "BOUNDARY_PREFLIGHT_FAILED"
  | "TARGET_PREFLIGHT_FAILED"
  | "OPERATION_PREFLIGHT_FAILED"
  | "INTENT_WRITE_FAILED"
  | "MUTATION_UNCERTAIN"
  | "RECONCILIATION_FAILED"
  | "RUNTIME_PROOF_FAILED"
  | "BOUNDARY_POSTFLIGHT_FAILED"
  | "TERMINAL_EVIDENCE_FAILED"
  | "INTERNAL_FAILURE";

interface Arguments {
  readonly mode: "authority" | "mutate";
  readonly target: TargetName;
  readonly operation: Operation;
  readonly candidateSha: string;
  readonly evidenceDirectory: string;
  readonly authorityFile: string | null;
}

interface VariableRow {
  readonly id: string;
  readonly name: string;
  readonly environmentId: string;
  readonly serviceId: string | null;
  readonly isSealed: boolean;
  readonly references: readonly string[];
}

interface DeploymentSummary {
  readonly id: string;
  readonly status: string;
  readonly deploymentStopped: boolean;
}

interface ProviderDomain {
  readonly kind: "service" | "custom";
  readonly id: string;
  readonly domain: string;
  readonly targetPort: number | null;
}

interface ProviderSnapshot {
  readonly environmentId: string;
  readonly serviceInstanceId: string;
  readonly serviceId: string;
  readonly numReplicas: number;
  readonly rows: readonly VariableRow[];
  readonly domains: readonly ProviderDomain[];
  readonly latestDeployment: DeploymentSummary & { readonly snapshotId: string };
  readonly activeDeployments: readonly DeploymentSummary[];
  readonly deployment: {
    readonly id: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly snapshotId: string;
    readonly commitHash: string;
    readonly imageDigest: string;
    readonly patchId: string | null;
  };
}

interface BoundaryEvidence {
  readonly passed: boolean;
  readonly receiptSha256: string | null;
}

interface RuntimeProof {
  readonly required: boolean;
  readonly observed: boolean;
  readonly pollRounds: number;
  readonly expectedSourceSha: string | null;
  readonly expectedAutomaticMaintenance: {
    readonly enabled: boolean;
    readonly candidateBound: boolean;
  } | null;
  readonly deploymentIdSha256: string | null;
  readonly responseSha256s: Readonly<Record<RuntimeRoute, string | null>>;
}

interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  tokenScopesExact: boolean;
  boundaryPreflightExact: boolean;
  targetPreflightExact: boolean;
  operationPreflightExact: boolean;
  durableIntentExact: boolean;
  writeAttemptedAtMostOnce: boolean;
  atomicVariablesExact: boolean;
  acknowledgementExact: boolean;
  postflightAttempted: boolean;
  targetPostflightExact: boolean;
  postflightDeploymentExact: boolean;
  runtimeRoutesPolledExact: boolean;
  runtimeMaintenanceStateExact: boolean;
  boundaryPostflightExact: boolean;
  noOtherProviderChanges: boolean;
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
  readonly reassertRepositoryState: (cwd: string, candidateSha: string) => boolean;
  readonly readAuthority: (filename: string) => string;
  readonly readActivationPrerequisite: (filename: string) => string;
  readonly parseActivationPrerequisite: (
    source: string,
    expected: {
      readonly candidateSha: string;
      readonly currentRunId: string;
      readonly roleLimitRunId: string;
      readonly now: Date;
    },
  ) => ProductionActivationRoleLimitPrerequisiteVerification;
  readonly writeDurable: (
    directory: string,
    leaf: string,
    source: string,
  ) => string;
  readonly writeOutput: (source: string) => void;
}

class OperationFailure extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode) {
    super(code);
    this.code = code;
  }
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

function exactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  return record(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function emptyChecks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    tokenScopesExact: false,
    boundaryPreflightExact: false,
    targetPreflightExact: false,
    operationPreflightExact: false,
    durableIntentExact: false,
    writeAttemptedAtMostOnce: true,
    atomicVariablesExact: false,
    acknowledgementExact: false,
    postflightAttempted: false,
    targetPostflightExact: false,
    postflightDeploymentExact: false,
    runtimeRoutesPolledExact: false,
    runtimeMaintenanceStateExact: false,
    boundaryPostflightExact: false,
    noOtherProviderChanges: false,
    terminalEvidenceExact: false,
  };
}

function parseArguments(argv: readonly string[]): Arguments | null {
  if (argv.length < 10 || argv.length > 12 || argv.length % 2 !== 0) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      ![
        "--mode",
        "--target",
        "--operation",
        "--candidate-sha",
        "--evidence-dir",
        "--authority-file",
      ].includes(key) ||
      values.has(key) ||
      value.length === 0
    ) return null;
    values.set(key, value);
  }
  const mode = values.get("--mode");
  const target = values.get("--target") as TargetName;
  const operation = values.get("--operation") as Operation;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const authorityFile = values.get("--authority-file") ?? null;
  if (
    (mode !== "authority" && mode !== "mutate") ||
    !Object.hasOwn(TARGETS, target) ||
    !Object.hasOwn(OPERATIONS, operation) ||
    !(OPERATIONS[operation].allowedTargets as readonly string[]).includes(target) ||
    !SHA_PATTERN.test(candidateSha) ||
    !path.isAbsolute(evidenceDirectory) ||
    (mode === "authority" && (argv.length !== 10 || authorityFile !== null)) ||
    (mode === "mutate" &&
      (argv.length !== 12 ||
        authorityFile !== path.join(evidenceDirectory, "authority.json")))
  ) return null;
  return {
    mode,
    target,
    operation,
    candidateSha,
    evidenceDirectory,
    authorityFile,
  };
}

function confirmation(target: TargetName, operation: Operation, candidate: string) {
  return `${operation.toUpperCase()}_AUTOMATIC_MAINTENANCE_IN_${target
    .toUpperCase()
    .replaceAll("-", "_")}_FOR_${candidate}`;
}

function policyExact(cwd: string): boolean {
  try {
    const policy = fs.readFileSync(path.resolve(cwd, POLICY_PATH));
    const boundary = fs.readFileSync(path.resolve(cwd, BOUNDARY_POLICY_PATH));
    if (
      policy.byteLength > MAX_EVIDENCE_BYTES ||
      sha256(policy) !== AUTOMATIC_MAINTENANCE_WORKER_FENCE_POLICY_SHA256 ||
      sha256(boundary) !== BOUNDARY_POLICY_SHA256
    ) return false;
    const value = JSON.parse(policy.toString("utf8")) as unknown;
    return exactKeys(value, [
      "schemaVersion",
      "policyId",
      "activationState",
      "repository",
      "branch",
      "projectId",
      "serviceId",
      "targets",
      "variables",
      "operations",
      "activationPrerequisites",
      "mutationBoundary",
      "mutation",
      "runtimeProof",
      "evidence",
    ]) &&
      value.schemaVersion === AUTOMATIC_MAINTENANCE_WORKER_FENCE_POLICY_SCHEMA &&
      value.activationState === AUTOMATIC_MAINTENANCE_WORKER_FENCE_EXECUTOR_STATE &&
      value.repository === REPOSITORY &&
      value.branch === BRANCH &&
      value.projectId === PROJECT_ID &&
      value.serviceId === SERVICE_ID &&
      JSON.stringify(value.variables) === JSON.stringify(VARIABLE_NAMES) &&
      record(value.activationPrerequisites) &&
      record(value.activationPrerequisites.production) &&
      value.activationPrerequisites.production.verificationFilename ===
        PRODUCTION_ACTIVATION_ROLE_LIMIT_PREREQUISITE_FILENAME &&
      value.activationPrerequisites.production.verificationSchema ===
        "pintpath-production-activation-role-limit-prerequisite/v1" &&
      value.activationPrerequisites.production
          .executorMustBindVerificationSha256 === true &&
      value.activationPrerequisites.production
          .executorMustBindRoleLimitRunId === true &&
      value.activationPrerequisites.production
          .liveDeploymentMustMatchRolePrerequisiteDeployment === true &&
      value.activationPrerequisites.production
          .runtimeAutomaticMaintenanceEnabledBeforeWrite === false &&
      value.activationPrerequisites.production
          .runtimeAutomaticMaintenanceCandidateBoundBeforeWrite === true;
  } catch {
    return false;
  }
}

async function boundedBody(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

async function githubGet(
  fetchImpl: typeof fetch,
  token: string,
  resource: string,
): Promise<unknown> {
  const response = await fetchImpl(`${GITHUB_ENDPOINT}/repos/${REPOSITORY}${resource}`, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const source = await boundedBody(response, MAX_GITHUB_BYTES);
  if (!response.ok) throw new Error("github_request_failed");
  return JSON.parse(source) as unknown;
}

async function railwayCall(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const response = await fetchImpl(RAILWAY_ENDPOINT, {
    method: "POST",
    headers: {
      "Project-Access-Token": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const source = await boundedBody(response, MAX_PROVIDER_BYTES);
  if (!response.ok) throw new Error("railway_request_failed");
  const value = JSON.parse(source) as unknown;
  if (record(value) && Object.hasOwn(value, "errors")) {
    throw new Error("railway_graphql_failed");
  }
  return value;
}

function validateGitCommit(value: unknown, expectedSha: string, linear: boolean) {
  if (
    !record(value) ||
    value.sha !== expectedSha ||
    !record(value.tree) ||
    typeof value.tree.sha !== "string" ||
    !SHA_PATTERN.test(value.tree.sha) ||
    !Array.isArray(value.parents) ||
    (linear && value.parents.length !== 1) ||
    value.parents.some((parent) =>
      !record(parent) || typeof parent.sha !== "string" || !SHA_PATTERN.test(parent.sha))
  ) throw new Error("reviewed_candidate_invalid");
  return { sha: expectedSha, treeSha: value.tree.sha };
}

function workflowTitle(args: Arguments): string {
  return `Automatic maintenance worker fence | ${args.target} | ${args.operation} | ${args.candidateSha}`;
}

function workflowRunExact(value: unknown, args: Arguments, runId: number): boolean {
  if (!record(value)) return false;
  const createdAt = timestamp(value.created_at);
  const startedAt = timestamp(value.run_started_at);
  return value.id === runId &&
    record(value.repository) &&
    value.repository.full_name === REPOSITORY &&
    record(value.head_repository) &&
    value.head_repository.full_name === REPOSITORY &&
    value.head_sha === args.candidateSha &&
    value.head_branch === BRANCH &&
    (value.path === WORKFLOW_PATH || value.path === `${WORKFLOW_PATH}@main`) &&
    value.event === "workflow_dispatch" &&
    value.display_title === workflowTitle(args) &&
    value.run_attempt === 1 &&
    ["queued", "in_progress", "waiting", "pending", "requested"].includes(
      String(value.status),
    ) &&
    value.conclusion === null &&
    createdAt !== null &&
    startedAt !== null &&
    createdAt <= startedAt;
}

async function reviewedCandidateAuthority(
  args: Arguments,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch,
): Promise<string> {
  const token = env.GITHUB_TOKEN ?? "";
  const runIdSource = env.GITHUB_RUN_ID ?? "";
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_SHA !== args.candidateSha ||
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_RUN_ATTEMPT !== "1" ||
    env.PINTPATH_PROTECTED_ENVIRONMENT !== TARGETS[args.target].githubEnvironment ||
    env.PINTPATH_AUTOMATIC_MAINTENANCE_CONFIRMATION !==
      confirmation(args.target, args.operation, args.candidateSha) ||
    !RUN_ID_PATTERN.test(runIdSource) ||
    !TOKEN_PATTERN.test(token)
  ) throw new OperationFailure("AUTHORITY_INVALID");
  const runId = Number(runIdSource);
  if (!Number.isSafeInteger(runId)) throw new OperationFailure("AUTHORITY_INVALID");

  const main = await githubGet(fetchImpl, token, `/git/ref/heads/${BRANCH}`);
  if (
    !record(main) ||
    main.ref !== `refs/heads/${BRANCH}` ||
    !record(main.object) ||
    main.object.type !== "commit" ||
    main.object.sha !== args.candidateSha
  ) throw new OperationFailure("AUTHORITY_INVALID");

  const associated: unknown[] = [];
  let associatedComplete = false;
  for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
    const batch = await githubGet(
      fetchImpl,
      token,
      `/commits/${args.candidateSha}/pulls?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length > 100) {
      throw new OperationFailure("AUTHORITY_INVALID");
    }
    associated.push(...batch);
    if (batch.length < 100) {
      associatedComplete = true;
      break;
    }
  }
  if (!associatedComplete) throw new OperationFailure("AUTHORITY_INVALID");
  const matches = associated.filter((candidate) =>
    record(candidate) &&
    Number.isSafeInteger(candidate.number) &&
    candidate.state === "closed" &&
    candidate.merge_commit_sha === args.candidateSha &&
    record(candidate.base) &&
    candidate.base.ref === BRANCH &&
    record(candidate.base.repo) &&
    candidate.base.repo.full_name === REPOSITORY &&
    record(candidate.head) &&
    record(candidate.head.repo) &&
    candidate.head.repo.full_name === REPOSITORY
  );
  if (matches.length !== 1) throw new OperationFailure("AUTHORITY_INVALID");
  const summary = matches[0] as Record<string, unknown>;
  const pull = await githubGet(fetchImpl, token, `/pulls/${String(summary.number)}`);
  if (
    !record(pull) ||
    pull.number !== summary.number ||
    pull.state !== "closed" ||
    pull.merged !== true ||
    pull.draft !== false ||
    pull.merge_commit_sha !== args.candidateSha ||
    !record(pull.base) ||
    pull.base.ref !== BRANCH ||
    !record(pull.base.repo) ||
    pull.base.repo.full_name !== REPOSITORY ||
    !record(pull.head) ||
    typeof pull.head.sha !== "string" ||
    !SHA_PATTERN.test(pull.head.sha) ||
    !record(pull.head.repo) ||
    pull.head.repo.full_name !== REPOSITORY ||
    !record(pull.user) ||
    !Number.isSafeInteger(pull.user.id) ||
    !record(pull.merged_by) ||
    !Number.isSafeInteger(pull.merged_by.id) ||
    timestamp(pull.merged_at) === null
  ) throw new OperationFailure("AUTHORITY_INVALID");
  const candidateCommit = validateGitCommit(
    await githubGet(fetchImpl, token, `/git/commits/${args.candidateSha}`),
    args.candidateSha,
    true,
  );
  const reviewedHead = pull.head.sha;
  const reviewedCommit = validateGitCommit(
    await githubGet(fetchImpl, token, `/git/commits/${reviewedHead}`),
    reviewedHead,
    false,
  );
  if (candidateCommit.treeSha !== reviewedCommit.treeSha) {
    throw new OperationFailure("AUTHORITY_INVALID");
  }

  const currentRun = await githubGet(fetchImpl, token, `/actions/runs/${runId}`);
  if (!workflowRunExact(currentRun, args, runId)) {
    throw new OperationFailure("AUTHORITY_INVALID");
  }
  const history: unknown[] = [];
  let historyTotal: number | null = null;
  let historyComplete = false;
  for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
    const listing = await githubGet(
      fetchImpl,
      token,
      `/actions/workflows/${WORKFLOW_ID}/runs?branch=${BRANCH}` +
        `&event=workflow_dispatch&per_page=100&page=${page}`,
    );
    if (
      !record(listing) ||
      !Number.isSafeInteger(listing.total_count) ||
      Number(listing.total_count) < 0 ||
      Number(listing.total_count) > MAX_HISTORY_PAGES * 100 ||
      !Array.isArray(listing.workflow_runs) ||
      listing.workflow_runs.length > 100 ||
      (historyTotal !== null && listing.total_count !== historyTotal)
    ) throw new OperationFailure("AUTHORITY_INVALID");
    historyTotal = Number(listing.total_count);
    history.push(...listing.workflow_runs);
    if (listing.workflow_runs.length < 100) {
      historyComplete = true;
      break;
    }
  }
  const matchingRuns = history.filter((run) =>
    record(run) &&
    run.head_sha === args.candidateSha &&
    run.display_title === workflowTitle(args)
  );
  if (
    !historyComplete ||
    history.length !== historyTotal ||
    matchingRuns.length !== 1 ||
    !workflowRunExact(matchingRuns[0], args, runId)
  ) throw new OperationFailure("AUTHORITY_INVALID");

  const run = currentRun as Record<string, unknown>;
  return canonical({
    schemaVersion: AUTOMATIC_MAINTENANCE_WORKER_FENCE_AUTHORITY_SCHEMA,
    repository: REPOSITORY,
    branch: BRANCH,
    workflowPath: WORKFLOW_PATH,
    workflowDisplayTitle: workflowTitle(args),
    runId: runIdSource,
    runAttempt: 1,
    runCreatedAt: run.created_at,
    runStartedAt: run.run_started_at,
    candidateSha: args.candidateSha,
    target: args.target,
    operation: args.operation,
    projectId: PROJECT_ID,
    environmentId: TARGETS[args.target].environmentId,
    serviceId: SERVICE_ID,
    reviewedPullRequest: {
      number: pull.number,
      reviewedHeadSha: reviewedHead,
      mergeCommitSha: args.candidateSha,
      treeSha: candidateCommit.treeSha,
      mergedAt: pull.merged_at,
      authorId: pull.user.id,
      mergedById: pull.merged_by.id,
    },
    checks: {
      exactCurrentMain: true,
      reviewedTreeExact: true,
      originalManualRunExact: true,
      noPriorMatchingRun: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function readAuthorityDefault(filename: string): string {
  return readTrustedRegularFile(filename, {
    minBytes: 1,
    maxBytes: MAX_EVIDENCE_BYTES,
    requireOwner: true,
    requirePrivate: true,
  }).toString("utf8");
}

const readActivationPrerequisiteDefault = readAuthorityDefault;

function reassertRepositoryState(cwd: string, candidateSha: string): boolean {
  try {
    const run = (args: readonly string[]): string => execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    execFileSync("git", [
      "fetch",
      "--no-tags",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ], { cwd, stdio: ["ignore", "ignore", "ignore"] });
    return run(["rev-parse", "HEAD"]) === candidateSha
      && run(["rev-parse", "refs/remotes/origin/main"]) === candidateSha
      && run(["status", "--porcelain=v2", "--untracked-files=all"]) === "";
  } catch {
    return false;
  }
}

function durableWriteDefault(directory: string, leaf: string, source: string): string {
  if (Buffer.byteLength(source) > MAX_EVIDENCE_BYTES) {
    throw new Error("evidence_too_large");
  }
  writePrivateExclusiveFile(directory, leaf, source, { requireOwner: true });
  return sha256(source);
}

function authorityReceiptExact(
  source: string,
  args: Arguments,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (
    Buffer.byteLength(source) > MAX_EVIDENCE_BYTES ||
    source.includes("\0") ||
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_SHA !== args.candidateSha ||
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_RUN_ATTEMPT !== "1" ||
    env.PINTPATH_PROTECTED_ENVIRONMENT !== TARGETS[args.target].githubEnvironment ||
    env.PINTPATH_AUTOMATIC_MAINTENANCE_CONFIRMATION !==
      confirmation(args.target, args.operation, args.candidateSha)
  ) return false;
  try {
    const value = JSON.parse(source) as unknown;
    return exactKeys(value, [
      "schemaVersion",
      "repository",
      "branch",
      "workflowPath",
      "workflowDisplayTitle",
      "runId",
      "runAttempt",
      "runCreatedAt",
      "runStartedAt",
      "candidateSha",
      "target",
      "operation",
      "projectId",
      "environmentId",
      "serviceId",
      "reviewedPullRequest",
      "checks",
      "secretMaterialIncluded",
      "secretDerivedCommitmentsIncluded",
    ]) &&
      value.schemaVersion === AUTOMATIC_MAINTENANCE_WORKER_FENCE_AUTHORITY_SCHEMA &&
      value.repository === REPOSITORY &&
      value.branch === BRANCH &&
      value.workflowPath === WORKFLOW_PATH &&
      value.workflowDisplayTitle === workflowTitle(args) &&
      value.runId === env.GITHUB_RUN_ID &&
      value.runAttempt === 1 &&
      timestamp(value.runCreatedAt) !== null &&
      timestamp(value.runStartedAt) !== null &&
      value.candidateSha === args.candidateSha &&
      value.target === args.target &&
      value.operation === args.operation &&
      value.projectId === PROJECT_ID &&
      value.environmentId === TARGETS[args.target].environmentId &&
      value.serviceId === SERVICE_ID &&
      exactKeys(value.reviewedPullRequest, [
        "number",
        "reviewedHeadSha",
        "mergeCommitSha",
        "treeSha",
        "mergedAt",
        "authorId",
        "mergedById",
      ]) &&
      Number.isSafeInteger(value.reviewedPullRequest.number) &&
      typeof value.reviewedPullRequest.reviewedHeadSha === "string" &&
      SHA_PATTERN.test(value.reviewedPullRequest.reviewedHeadSha) &&
      value.reviewedPullRequest.mergeCommitSha === args.candidateSha &&
      typeof value.reviewedPullRequest.treeSha === "string" &&
      SHA_PATTERN.test(value.reviewedPullRequest.treeSha) &&
      timestamp(value.reviewedPullRequest.mergedAt) !== null &&
      Number.isSafeInteger(value.reviewedPullRequest.authorId) &&
      Number.isSafeInteger(value.reviewedPullRequest.mergedById) &&
      exactKeys(value.checks, [
        "exactCurrentMain",
        "reviewedTreeExact",
        "originalManualRunExact",
        "noPriorMatchingRun",
      ]) &&
      Object.values(value.checks).every((check) => check === true) &&
      value.secretMaterialIncluded === false &&
      value.secretDerivedCommitmentsIncluded === false;
  } catch {
    return false;
  }
}

function tokenScopeExact(value: unknown, environmentId: string): boolean {
  return exactKeys(value, ["data"]) &&
    exactKeys(value.data, ["projectToken"]) &&
    exactKeys(value.data.projectToken, ["projectId", "environmentId"]) &&
    value.data.projectToken.projectId === PROJECT_ID &&
    value.data.projectToken.environmentId === environmentId;
}

function variableRow(value: unknown, environmentId: string): VariableRow | null {
  if (
    !exactKeys(value, [
      "id",
      "name",
      "environmentId",
      "serviceId",
      "isSealed",
      "references",
    ]) ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 256 ||
    typeof value.name !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,127}$/.test(value.name) ||
    value.environmentId !== environmentId ||
    !(value.serviceId === null ||
      (typeof value.serviceId === "string" && UUID_PATTERN.test(value.serviceId))) ||
    typeof value.isSealed !== "boolean" ||
    !Array.isArray(value.references) ||
    value.references.some((item) =>
      typeof item !== "string" || item.length > 512 || /[\r\n\0]/.test(item))
  ) return null;
  return {
    id: value.id,
    name: value.name,
    environmentId,
    serviceId: value.serviceId as string | null,
    isSealed: value.isSealed,
    references: [...value.references].sort() as string[],
  };
}

function deploymentSummary(value: unknown): DeploymentSummary | null {
  if (
    !exactKeys(value, ["id", "status", "deploymentStopped"]) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.status !== "string" ||
    !/^[A-Z_]{1,32}$/.test(value.status) ||
    typeof value.deploymentStopped !== "boolean"
  ) return null;
  return {
    id: value.id,
    status: value.status,
    deploymentStopped: value.deploymentStopped,
  };
}

function providerDomain(
  value: unknown,
  kind: ProviderDomain["kind"],
): ProviderDomain | null {
  if (
    !exactKeys(value, ["id", "domain", "targetPort"]) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.domain !== "string" ||
    !/^[a-z0-9.-]{1,253}$/.test(value.domain) ||
    !(value.targetPort === null ||
      (Number.isSafeInteger(value.targetPort) &&
        Number(value.targetPort) >= 1 &&
        Number(value.targetPort) <= 65_535))
  ) return null;
  return {
    kind,
    id: value.id,
    domain: value.domain,
    targetPort: value.targetPort as number | null,
  };
}

function metadataPart(value: unknown, environmentId: string) {
  if (
    !exactKeys(value, ["data"]) ||
    !exactKeys(value.data, ["environment", "staged", "serviceInstance"])
  ) return null;
  const environment = value.data.environment;
  const staged = value.data.staged;
  const instance = value.data.serviceInstance;
  if (
    !exactKeys(environment, ["id", "variables"]) ||
    environment.id !== environmentId ||
    !exactKeys(environment.variables, ["edges", "pageInfo"]) ||
    !Array.isArray(environment.variables.edges) ||
    environment.variables.edges.length > 100 ||
    !exactKeys(environment.variables.pageInfo, ["hasNextPage", "endCursor"]) ||
    environment.variables.pageInfo.hasNextPage !== false ||
    !exactKeys(staged, ["environmentId", "patch"]) ||
    staged.environmentId !== environmentId ||
    !record(staged.patch) ||
    Object.keys(staged.patch).length !== 0 ||
    !exactKeys(instance, [
      "id",
      "serviceId",
      "environmentId",
      "numReplicas",
      "latestDeployment",
      "activeDeployments",
      "domains",
    ]) ||
    typeof instance.id !== "string" ||
    !UUID_PATTERN.test(instance.id) ||
    instance.serviceId !== SERVICE_ID ||
    instance.environmentId !== environmentId ||
    !Number.isSafeInteger(instance.numReplicas) ||
    Number(instance.numReplicas) < 1 ||
    Number(instance.numReplicas) > 50 ||
    !exactKeys(instance.latestDeployment, [
      "id",
      "status",
      "deploymentStopped",
      "snapshotId",
    ]) ||
    typeof instance.latestDeployment.snapshotId !== "string" ||
    !UUID_PATTERN.test(instance.latestDeployment.snapshotId) ||
    !Array.isArray(instance.activeDeployments) ||
    instance.activeDeployments.length > 100 ||
    !exactKeys(instance.domains, ["serviceDomains", "customDomains"]) ||
    !Array.isArray(instance.domains.serviceDomains) ||
    !Array.isArray(instance.domains.customDomains) ||
    instance.domains.serviceDomains.length > 100 ||
    instance.domains.customDomains.length > 100
  ) return null;
  const latest = deploymentSummary({
    id: instance.latestDeployment.id,
    status: instance.latestDeployment.status,
    deploymentStopped: instance.latestDeployment.deploymentStopped,
  });
  if (!latest) return null;
  const activeDeployments: DeploymentSummary[] = [];
  for (const candidate of instance.activeDeployments) {
    const parsed = deploymentSummary(candidate);
    if (!parsed) return null;
    activeDeployments.push(parsed);
  }
  if (new Set(activeDeployments.map((item) => item.id)).size !== activeDeployments.length) {
    return null;
  }
  const domains: ProviderDomain[] = [];
  for (const candidate of instance.domains.serviceDomains) {
    const parsed = providerDomain(candidate, "service");
    if (!parsed) return null;
    domains.push(parsed);
  }
  for (const candidate of instance.domains.customDomains) {
    const parsed = providerDomain(candidate, "custom");
    if (!parsed) return null;
    domains.push(parsed);
  }
  domains.sort((left, right) =>
    `${left.kind}:${left.domain}:${left.id}`.localeCompare(
      `${right.kind}:${right.domain}:${right.id}`,
    ));
  if (
    new Set(domains.map((item) => item.id)).size !== domains.length ||
    new Set(domains.map((item) => item.domain)).size !== domains.length
  ) return null;
  const rows: VariableRow[] = [];
  for (const edge of environment.variables.edges) {
    if (!exactKeys(edge, ["node"])) return null;
    const parsed = variableRow(edge.node, environmentId);
    if (!parsed) return null;
    rows.push(parsed);
  }
  rows.sort((left, right) =>
    `${String(left.serviceId)}:${left.name}`.localeCompare(
      `${String(right.serviceId)}:${right.name}`,
    ));
  if (new Set(rows.map((item) => `${String(item.serviceId)}:${item.name}`)).size !== rows.length) {
    return null;
  }
  return {
    environmentId,
    serviceInstanceId: instance.id,
    serviceId: SERVICE_ID,
    numReplicas: Number(instance.numReplicas),
    rows,
    domains,
    latestDeployment: { ...latest, snapshotId: instance.latestDeployment.snapshotId },
    activeDeployments,
  };
}

function deploymentPart(value: unknown, expectedId: string) {
  if (
    !exactKeys(value, ["data"]) ||
    !exactKeys(value.data, ["deployment"]) ||
    !exactKeys(value.data.deployment, [
      "id",
      "projectId",
      "environmentId",
      "serviceId",
      "snapshotId",
      "meta",
    ])
  ) return null;
  const deployment = value.data.deployment;
  if (
    deployment.id !== expectedId ||
    deployment.projectId !== PROJECT_ID ||
    typeof deployment.environmentId !== "string" ||
    !UUID_PATTERN.test(deployment.environmentId) ||
    deployment.serviceId !== SERVICE_ID ||
    typeof deployment.snapshotId !== "string" ||
    !UUID_PATTERN.test(deployment.snapshotId) ||
    !record(deployment.meta)
  ) return null;
  const commitHash = deployment.meta.commitHash;
  const imageDigest = deployment.meta.imageDigest;
  const patchId = deployment.meta.patchId;
  if (
    typeof commitHash !== "string" ||
    !SHA_PATTERN.test(commitHash) ||
    typeof imageDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(imageDigest) ||
    !(patchId === null || (typeof patchId === "string" && UUID_PATTERN.test(patchId)))
  ) return null;
  return {
    id: deployment.id as string,
    projectId: PROJECT_ID,
    environmentId: deployment.environmentId,
    serviceId: SERVICE_ID,
    snapshotId: deployment.snapshotId,
    commitHash,
    imageDigest,
    patchId: patchId as string | null,
  };
}

async function readProviderSnapshot(
  dependencies: Dependencies,
  metadataToken: string,
  environmentId: string,
): Promise<ProviderSnapshot | null> {
  try {
    const metadata = metadataPart(
      await railwayCall(
        dependencies.fetchImpl,
        metadataToken,
        AUTOMATIC_MAINTENANCE_WORKER_FENCE_METADATA_QUERY,
        { projectId: PROJECT_ID, environmentId, serviceId: SERVICE_ID },
      ),
      environmentId,
    );
    if (!metadata) return null;
    const deployment = deploymentPart(
      await railwayCall(
        dependencies.fetchImpl,
        metadataToken,
        AUTOMATIC_MAINTENANCE_WORKER_FENCE_DEPLOYMENT_QUERY,
        { deploymentId: metadata.latestDeployment.id },
      ),
      metadata.latestDeployment.id,
    );
    if (
      !deployment ||
      deployment.environmentId !== environmentId ||
      deployment.snapshotId !== metadata.latestDeployment.snapshotId
    ) return null;
    return { ...metadata, deployment };
  } catch {
    return null;
  }
}

function targetRowsBeforeExact(snapshot: ProviderSnapshot): boolean {
  return VARIABLE_NAMES.every((name) => {
    const matches = snapshot.rows.filter((row) => row.name === name);
    return matches.length === 0 ||
      (matches.length === 1 &&
        matches[0]?.serviceId === SERVICE_ID &&
        matches[0].references.length === 0);
  });
}

function otherRows(snapshot: ProviderSnapshot): readonly VariableRow[] {
  return snapshot.rows.filter((row) =>
    !VARIABLE_NAMES.includes(row.name as (typeof VARIABLE_NAMES)[number]));
}

function targetRowsAfterExact(before: ProviderSnapshot, after: ProviderSnapshot): boolean {
  const targetRows = after.rows.filter((row) =>
    VARIABLE_NAMES.includes(row.name as (typeof VARIABLE_NAMES)[number]));
  return targetRows.length === 2 &&
    VARIABLE_NAMES.every((name) => {
      const matches = targetRows.filter((row) => row.name === name);
      return matches.length === 1 &&
        matches[0]?.serviceId === SERVICE_ID &&
        matches[0].references.length === 0;
    }) &&
    canonical(otherRows(before)) === canonical(otherRows(after));
}

function serviceShapeStable(before: ProviderSnapshot, after: ProviderSnapshot): boolean {
  return before.environmentId === after.environmentId &&
    before.serviceInstanceId === after.serviceInstanceId &&
    before.serviceId === after.serviceId &&
    before.numReplicas === after.numReplicas &&
    canonical(before.domains) === canonical(after.domains);
}

function targetOriginAttached(
  snapshot: ProviderSnapshot,
  target: TargetName,
): boolean {
  const expectedHost = new URL(TARGETS[target].publicOrigin).hostname;
  return snapshot.domains.filter((domain) => domain.domain === expectedHost).length === 1;
}

function deploymentCanonical(snapshot: ProviderSnapshot): string {
  return canonical({
    latestDeployment: snapshot.latestDeployment,
    activeDeployments: snapshot.activeDeployments,
    deployment: snapshot.deployment,
  });
}

function topologyCanonical(snapshot: ProviderSnapshot): string {
  return canonical({
    environmentId: snapshot.environmentId,
    serviceInstanceId: snapshot.serviceInstanceId,
    serviceId: snapshot.serviceId,
    numReplicas: snapshot.numReplicas,
    domains: snapshot.domains,
  });
}

function soleHealthyCandidate(snapshot: ProviderSnapshot, candidateSha: string): boolean {
  const active = snapshot.activeDeployments[0];
  return snapshot.latestDeployment.status === "SUCCESS" &&
    snapshot.latestDeployment.deploymentStopped === false &&
    snapshot.activeDeployments.length === 1 &&
    active?.id === snapshot.latestDeployment.id &&
    active.status === "SUCCESS" &&
    active.deploymentStopped === false &&
    snapshot.deployment.id === snapshot.latestDeployment.id &&
    snapshot.deployment.projectId === PROJECT_ID &&
    snapshot.deployment.environmentId === snapshot.environmentId &&
    snapshot.deployment.serviceId === SERVICE_ID &&
    snapshot.deployment.snapshotId === snapshot.latestDeployment.snapshotId &&
    snapshot.deployment.commitHash === candidateSha &&
    snapshot.deployment.patchId === null;
}

async function runtimeResponse(
  dependencies: Dependencies,
  origin: string,
  route: RuntimeRoute,
  expectedSourceSha: string,
  expectedEnabled: boolean,
  expectedCandidateBound: boolean,
  environmentId: string,
  deploymentId: string,
): Promise<string | null> {
  try {
    const response = await dependencies.fetchImpl(`${origin}${route}`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const source = await boundedBody(response, MAX_RUNTIME_BYTES);
    if (!response.ok) return null;
    const value = JSON.parse(source) as unknown;
    const expectedStatus = route === "/health"
      ? "ok"
      : route === "/startup"
        ? "startup_ready"
        : "ready";
    const expectedDataKeys = route === "/health"
      ? ["service", "status", "deployment", "automaticMaintenance"]
      : ["service", "status", "deployment", "automaticMaintenance", "dependencies"];
    if (
      !exactKeys(value, ["ok", "data"]) ||
      value.ok !== true ||
      !exactKeys(value.data, expectedDataKeys) ||
      value.data.service !== "pint-path" ||
      value.data.status !== expectedStatus ||
      !exactKeys(value.data.automaticMaintenance, ["enabled", "candidateBound"]) ||
      value.data.automaticMaintenance.enabled !== expectedEnabled ||
      value.data.automaticMaintenance.candidateBound !== expectedCandidateBound ||
      !exactKeys(value.data.deployment, [
        "version",
        "commitSha",
        "environment",
        "projectIdSha256",
        "environmentIdSha256",
        "serviceIdSha256",
        "deploymentIdSha256",
        "replicaIdSha256",
      ]) ||
      value.data.deployment.commitSha !== expectedSourceSha ||
      value.data.deployment.environment !== "production" ||
      value.data.deployment.projectIdSha256 !==
        railwayDeploymentIdentityIdSha256("project", PROJECT_ID) ||
      value.data.deployment.environmentIdSha256 !==
        railwayDeploymentIdentityIdSha256("environment", environmentId) ||
      value.data.deployment.serviceIdSha256 !==
        railwayDeploymentIdentityIdSha256("service", SERVICE_ID) ||
      value.data.deployment.deploymentIdSha256 !==
        railwayDeploymentIdentityIdSha256("deployment", deploymentId) ||
      typeof value.data.deployment.replicaIdSha256 !== "string" ||
      !SHA256_PATTERN.test(value.data.deployment.replicaIdSha256)
    ) return null;
    return sha256(source);
  } catch {
    return null;
  }
}

async function reconcileAfterWrite(
  dependencies: Dependencies,
  args: Arguments,
  metadataToken: string,
  before: ProviderSnapshot,
): Promise<{ readonly snapshot: ProviderSnapshot | null; readonly runtime: RuntimeProof }> {
  const operation = OPERATIONS[args.operation];
  const maximumRounds = operation.requiresRuntimeProof
    ? Math.floor(900 / 10) + 1
    : 1;
  const startedAt = dependencies.now();
  const expectedSourceSha = args.candidateSha;
  let latest: ProviderSnapshot | null = null;
  let runtime: RuntimeProof = {
    required: OPERATIONS[args.operation].requiresRuntimeProof,
    observed: false,
    pollRounds: 0,
    expectedSourceSha: operation.requiresRuntimeProof ? expectedSourceSha : null,
    expectedAutomaticMaintenance: operation.requiresRuntimeProof
      ? {
        enabled: operation.runtimeEnabled,
        candidateBound: operation.runtimeCandidateBound,
      }
      : null,
    deploymentIdSha256: null,
    responseSha256s: { "/health": null, "/startup": null, "/ready": null },
  };
  for (let round = 1; round <= maximumRounds; round += 1) {
    latest = await readProviderSnapshot(
      dependencies,
      metadataToken,
      TARGETS[args.target].environmentId,
    );
    const targetExact = latest !== null &&
      targetRowsAfterExact(before, latest) &&
      serviceShapeStable(before, latest);
    const deploymentExact = latest !== null && (
      operation.postflightMode === "unchanged"
        ? deploymentCanonical(before) === deploymentCanonical(latest)
        : soleHealthyCandidate(latest, args.candidateSha)
    );
    if (targetExact && deploymentExact) {
      if (!operation.requiresRuntimeProof) {
        return { snapshot: latest, runtime };
      }
      const results = await Promise.all(
        RUNTIME_ROUTES.map((route) =>
          runtimeResponse(
            dependencies,
            TARGETS[args.target].publicOrigin,
            route,
            expectedSourceSha,
            operation.runtimeEnabled,
            operation.runtimeCandidateBound,
            TARGETS[args.target].environmentId,
            latest!.deployment.id,
          )),
      );
      runtime = {
        required: true,
        observed: results.every((result) => result !== null),
        pollRounds: round,
        expectedSourceSha,
        expectedAutomaticMaintenance: {
          enabled: operation.runtimeEnabled,
          candidateBound: operation.runtimeCandidateBound,
        },
        deploymentIdSha256: railwayDeploymentIdentityIdSha256(
          "deployment",
          latest!.deployment.id,
        )!,
        responseSha256s: {
          "/health": results[0] ?? null,
          "/startup": results[1] ?? null,
          "/ready": results[2] ?? null,
        },
      };
      if (runtime.observed) return { snapshot: latest, runtime };
    }
    if (
      round === maximumRounds ||
      dependencies.now() - startedAt >= 900_000
    ) break;
    await dependencies.sleep(10_000);
  }
  return { snapshot: latest, runtime };
}

async function defaultBoundaryCheck(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch,
): Promise<BoundaryEvidence> {
  let source = "";
  const code = await runRailwayMutationBoundaryCheck({
    argv: ["--policy", BOUNDARY_POLICY_PATH],
    env,
    fetchImpl,
    writeOutput: (chunk) => {
      if (Buffer.byteLength(source) + Buffer.byteLength(chunk) > MAX_EVIDENCE_BYTES) {
        throw new Error("boundary_receipt_too_large");
      }
      source += chunk;
    },
  });
  return {
    passed: code === 0,
    receiptSha256: source.length === 0 ? null : sha256(source),
  };
}

function fixedOutput(
  args: Arguments | null,
  outcome: "authorized" | "prepared" | "fenced" | "activated" |
    "failed_before_attempt" | "mutation_uncertain",
  attempts: 0 | 1,
  failureCode: FailureCode | null,
  authoritySha256: string | null,
  intentSha256: string | null,
  terminalSha256: string | null,
  checks: Checks,
) {
  return {
    schemaVersion: "pintpath-automatic-maintenance-worker-fence-executor-output/v1",
    executorState: AUTOMATIC_MAINTENANCE_WORKER_FENCE_EXECUTOR_STATE,
    mode: args?.mode ?? null,
    target: args?.target ?? null,
    operation: args?.operation ?? null,
    candidateSha: args?.candidateSha ?? null,
    outcome,
    attempts,
    retryAllowed: false as const,
    failureCode,
    authoritySha256,
    intentSha256,
    terminalSha256,
    checks,
  };
}

function nextFailure(checks: Checks, operation: Operation): FailureCode | null {
  if (!checks.atomicVariablesExact || !checks.writeAttemptedAtMostOnce) {
    return "MUTATION_UNCERTAIN";
  }
  if (!checks.acknowledgementExact) return "MUTATION_UNCERTAIN";
  if (!checks.postflightAttempted || !checks.targetPostflightExact ||
    !checks.noOtherProviderChanges) return "RECONCILIATION_FAILED";
  if (!checks.postflightDeploymentExact) return "RECONCILIATION_FAILED";
  if (OPERATIONS[operation].requiresRuntimeProof &&
    (!checks.postflightDeploymentExact ||
      !checks.runtimeRoutesPolledExact ||
      !checks.runtimeMaintenanceStateExact)) return "RUNTIME_PROOF_FAILED";
  if (!checks.boundaryPostflightExact) return "BOUNDARY_POSTFLIGHT_FAILED";
  return null;
}

async function runAuthorityMode(
  dependencies: Dependencies,
  args: Arguments,
  checks: Checks,
): Promise<0 | 1> {
  let authoritySha: string | null = null;
  let failureCode: FailureCode | null = null;
  try {
    if (!checks.policyExact) throw new OperationFailure("POLICY_INVALID");
    const authority = await reviewedCandidateAuthority(
      args,
      dependencies.env,
      dependencies.fetchImpl,
    );
    authoritySha = dependencies.writeDurable(
      args.evidenceDirectory,
      "authority.json",
      authority,
    );
    checks.githubAuthorityExact = authoritySha === sha256(authority);
    if (!checks.githubAuthorityExact) throw new OperationFailure("AUTHORITY_INVALID");
  } catch (error) {
    failureCode = error instanceof OperationFailure
      ? error.code
      : "AUTHORITY_INVALID";
  }
  dependencies.writeOutput(`${JSON.stringify(fixedOutput(
    args,
    failureCode === null ? "authorized" : "failed_before_attempt",
    0,
    failureCode,
    authoritySha,
    null,
    null,
    checks,
  ))}\n`);
  return failureCode === null ? 0 : 1;
}

async function runMutationMode(
  dependencies: Dependencies,
  args: Arguments,
  checks: Checks,
): Promise<0 | 1> {
  let failureCode: FailureCode | null = null;
  let attempts: 0 | 1 = 0;
  let authoritySha: string | null = null;
  let intentSha: string | null = null;
  let terminalSha: string | null = null;
  let metadataToken = "";
  let before: ProviderSnapshot | null = null;
  let after: ProviderSnapshot | null = null;
  let boundaryBefore: BoundaryEvidence = { passed: false, receiptSha256: null };
  let boundaryAfter: BoundaryEvidence = { passed: false, receiptSha256: null };
  let productionActivationPrerequisite: {
    readonly verificationSha256: string;
    readonly roleLimitRunId: string;
    readonly expectedDeploymentIdSha256: string;
    readonly liveDeploymentIdSha256: string | null;
    readonly runtimeResponseSha256s: Readonly<Record<RuntimeRoute, string | null>>;
  } | null = null;
  let runtime: RuntimeProof = {
    required: OPERATIONS[args.operation].requiresRuntimeProof,
    observed: false,
    pollRounds: 0,
    expectedSourceSha: null,
    expectedAutomaticMaintenance: null,
    deploymentIdSha256: null,
    responseSha256s: { "/health": null, "/startup": null, "/ready": null },
  };
  const target = TARGETS[args.target];
  const operation = OPERATIONS[args.operation];
  try {
    if (!checks.policyExact) throw new OperationFailure("POLICY_INVALID");
    if (args.target === "production" && args.operation === "activate") {
      const roleLimitRunId =
        dependencies.env.PINTPATH_PRODUCTION_ACTIVATE_ROLE_LIMIT_RUN_ID ?? "";
      const currentRunId = dependencies.env.GITHUB_RUN_ID ?? "";
      if (
        !RUN_ID_PATTERN.test(roleLimitRunId) ||
        !RUN_ID_PATTERN.test(currentRunId) ||
        roleLimitRunId === currentRunId
      ) throw new OperationFailure("ACTIVATION_PREREQUISITE_INVALID");
      let verificationSource: string;
      let verification: ProductionActivationRoleLimitPrerequisiteVerification;
      try {
        verificationSource = dependencies.readActivationPrerequisite(
          path.join(
            args.evidenceDirectory,
            PRODUCTION_ACTIVATION_ROLE_LIMIT_PREREQUISITE_FILENAME,
          ),
        );
        verification = dependencies.parseActivationPrerequisite(
          verificationSource,
          {
            candidateSha: args.candidateSha,
            currentRunId,
            roleLimitRunId,
            now: new Date(dependencies.now()),
          },
        );
      } catch {
        throw new OperationFailure("ACTIVATION_PREREQUISITE_INVALID");
      }
      productionActivationPrerequisite = {
        verificationSha256: sha256(verificationSource),
        roleLimitRunId,
        expectedDeploymentIdSha256:
          verification.rolePrerequisites.productionDeployment.deploymentIdSha256,
        liveDeploymentIdSha256: null,
        runtimeResponseSha256s: {
          "/health": null,
          "/startup": null,
          "/ready": null,
        },
      };
    }
    let authoritySource: string;
    try {
      authoritySource = dependencies.readAuthority(args.authorityFile!);
    } catch {
      throw new OperationFailure("AUTHORITY_RECEIPT_INVALID");
    }
    authoritySha = sha256(authoritySource);
    checks.githubAuthorityExact = authorityReceiptExact(
      authoritySource,
      args,
      dependencies.env,
    );
    if (!checks.githubAuthorityExact) {
      throw new OperationFailure("AUTHORITY_RECEIPT_INVALID");
    }
    metadataToken = dependencies.env.PINTPATH_RAILWAY_TARGET_METADATA_TOKEN ?? "";
    const writeToken = dependencies.env.PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN ?? "";
    const productionMetadata =
      dependencies.env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? "";
    const stagingMetadata =
      dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    if (
      !TOKEN_PATTERN.test(metadataToken) ||
      !TOKEN_PATTERN.test(writeToken) ||
      !TOKEN_PATTERN.test(productionMetadata) ||
      !TOKEN_PATTERN.test(stagingMetadata) ||
      productionMetadata === stagingMetadata ||
      writeToken === productionMetadata ||
      writeToken === stagingMetadata ||
      metadataToken !== (args.target === "production"
        ? productionMetadata
        : stagingMetadata)
    ) throw new OperationFailure("TOKEN_CONFIGURATION_INVALID");

    let metadataScope: unknown;
    let writeScope: unknown;
    try {
      [metadataScope, writeScope] = await Promise.all([
        railwayCall(
          dependencies.fetchImpl,
          metadataToken,
          AUTOMATIC_MAINTENANCE_WORKER_FENCE_SCOPE_QUERY,
          {},
        ),
        railwayCall(
          dependencies.fetchImpl,
          writeToken,
          AUTOMATIC_MAINTENANCE_WORKER_FENCE_SCOPE_QUERY,
          {},
        ),
      ]);
    } catch {
      throw new OperationFailure("TOKEN_SCOPE_INVALID");
    }
    checks.tokenScopesExact =
      tokenScopeExact(metadataScope, target.environmentId) &&
      tokenScopeExact(writeScope, target.environmentId);
    if (!checks.tokenScopesExact) throw new OperationFailure("TOKEN_SCOPE_INVALID");
    try {
      boundaryBefore = await dependencies.boundaryCheck();
    } catch {
      throw new OperationFailure("BOUNDARY_PREFLIGHT_FAILED");
    }
    checks.boundaryPreflightExact = boundaryBefore.passed &&
      boundaryBefore.receiptSha256 !== null;
    if (!checks.boundaryPreflightExact) {
      throw new OperationFailure("BOUNDARY_PREFLIGHT_FAILED");
    }
    before = await readProviderSnapshot(
      dependencies,
      metadataToken,
      target.environmentId,
    );
    checks.targetPreflightExact = before !== null &&
      targetRowsBeforeExact(before) &&
      targetOriginAttached(before, args.target);
    if (!checks.targetPreflightExact) {
      throw new OperationFailure("TARGET_PREFLIGHT_FAILED");
    }
    checks.operationPreflightExact = before !== null && (
      operation.preflightMode === "none" ||
      (operation.preflightMode === "healthy-candidate" &&
        soleHealthyCandidate(before, args.candidateSha))
    );
    if (
      checks.operationPreflightExact &&
      args.target === "production" &&
      args.operation === "activate" &&
      before !== null &&
      productionActivationPrerequisite !== null
    ) {
      const expectedDeploymentIdSha256 =
        productionActivationPrerequisite.expectedDeploymentIdSha256;
      const liveDeploymentIdSha256 = railwayDeploymentIdentityIdSha256(
        "deployment",
        before.deployment.id,
      ) ?? null;
      const results = await Promise.all(
        RUNTIME_ROUTES.map((route) =>
          runtimeResponse(
            dependencies,
            TARGETS.production.publicOrigin,
            route,
            args.candidateSha,
            false,
            true,
            TARGETS.production.environmentId,
            before!.deployment.id,
          )),
      );
      productionActivationPrerequisite = {
        ...productionActivationPrerequisite,
        liveDeploymentIdSha256,
        runtimeResponseSha256s: {
          "/health": results[0] ?? null,
          "/startup": results[1] ?? null,
          "/ready": results[2] ?? null,
        },
      };
      checks.operationPreflightExact =
        liveDeploymentIdSha256 !== null &&
        liveDeploymentIdSha256 === expectedDeploymentIdSha256 &&
        results.every((result) => result !== null);
    }
    if (!checks.operationPreflightExact) {
      throw new OperationFailure("OPERATION_PREFLIGHT_FAILED");
    }

    const configuredVariables = {
      PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED: operation.enabledValue,
      PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: args.candidateSha,
    };
    const binding = {
      policySha256: AUTOMATIC_MAINTENANCE_WORKER_FENCE_POLICY_SHA256,
      candidateSha: args.candidateSha,
      target: args.target,
      operation: args.operation,
      projectId: PROJECT_ID,
      environmentId: target.environmentId,
      serviceId: SERVICE_ID,
      configuredVariables,
      skipDeploys: operation.skipDeploys,
    };
    const intent = canonical({
      schemaVersion: AUTOMATIC_MAINTENANCE_WORKER_FENCE_INTENT_SCHEMA,
      binding,
      bindingSha256: sha256(canonical(binding)),
      authoritySha256: authoritySha,
      graphqlOperation: "variableCollectionUpsert",
      maximumAttempts: 1,
      retryAllowed: false,
      preflightProviderSha256: sha256(canonical(before)),
      boundaryPreflightReceiptSha256: boundaryBefore.receiptSha256,
      productionActivationPrerequisite,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    try {
      intentSha = dependencies.writeDurable(
        args.evidenceDirectory,
        "intent.json",
        intent,
      );
    } catch {
      throw new OperationFailure("INTENT_WRITE_FAILED");
    }
    checks.durableIntentExact = intentSha === sha256(intent);
    if (!checks.durableIntentExact) throw new OperationFailure("INTENT_WRITE_FAILED");

    checks.githubAuthorityExact = checks.githubAuthorityExact &&
      dependencies.reassertRepositoryState(dependencies.cwd, args.candidateSha);
    if (!checks.githubAuthorityExact) {
      throw new OperationFailure("AUTHORITY_RECEIPT_INVALID");
    }

    if (args.operation === "activate") {
      const prewriteRuntime = await Promise.all(
        RUNTIME_ROUTES.map((route) =>
          runtimeResponse(
            dependencies,
            target.publicOrigin,
            route,
            args.candidateSha,
            false,
            true,
            target.environmentId,
            before!.deployment.id,
          )),
      );
      checks.operationPreflightExact = checks.operationPreflightExact &&
        prewriteRuntime.every((result) => result !== null);
      if (!checks.operationPreflightExact) {
        throw new OperationFailure("OPERATION_PREFLIGHT_FAILED");
      }
    }

    const prewrite = await readProviderSnapshot(
      dependencies,
      metadataToken,
      target.environmentId,
    );
    checks.targetPreflightExact = checks.targetPreflightExact &&
      prewrite !== null &&
      canonical(prewrite) === canonical(before) &&
      targetRowsBeforeExact(prewrite) &&
      targetOriginAttached(prewrite, args.target);
    if (!checks.targetPreflightExact) {
      throw new OperationFailure("TARGET_PREFLIGHT_FAILED");
    }

    attempts = 1;
    try {
      const response = await railwayCall(
        dependencies.fetchImpl,
        writeToken,
        AUTOMATIC_MAINTENANCE_WORKER_FENCE_MUTATION,
        {
          projectId: PROJECT_ID,
          serviceId: SERVICE_ID,
          environmentId: target.environmentId,
          variables: configuredVariables,
          skipDeploys: operation.skipDeploys,
        },
      );
      checks.atomicVariablesExact =
        Object.keys(configuredVariables).length === 2 &&
        Object.keys(configuredVariables)[0] === VARIABLE_NAMES[0] &&
        Object.keys(configuredVariables)[1] === VARIABLE_NAMES[1];
      checks.acknowledgementExact = exactKeys(response, ["data"]) &&
        exactKeys(response.data, ["variableCollectionUpsert"]) &&
        response.data.variableCollectionUpsert === true;
    } catch {
      checks.acknowledgementExact = false;
    }
  } catch (error) {
    failureCode = error instanceof OperationFailure
      ? error.code
      : "INTERNAL_FAILURE";
  } finally {
    if (attempts === 1 && before !== null) {
      checks.postflightAttempted = true;
      try {
        const reconciled = await reconcileAfterWrite(
          dependencies,
          args,
          metadataToken,
          before,
        );
        after = reconciled.snapshot;
        runtime = reconciled.runtime;
      } catch {
        after = null;
      }
      checks.targetPostflightExact = after !== null &&
        targetRowsAfterExact(before, after) &&
        targetOriginAttached(after, args.target);
      checks.noOtherProviderChanges = after !== null &&
        serviceShapeStable(before, after) &&
        canonical(otherRows(before)) === canonical(otherRows(after));
      checks.postflightDeploymentExact = after !== null && (
        operation.postflightMode === "unchanged"
          ? deploymentCanonical(before) === deploymentCanonical(after)
          : soleHealthyCandidate(after, args.candidateSha)
      );
      checks.runtimeRoutesPolledExact = !operation.requiresRuntimeProof ||
        runtime.pollRounds > 0;
      checks.runtimeMaintenanceStateExact =
        !operation.requiresRuntimeProof || runtime.observed;
      try {
        boundaryAfter = await dependencies.boundaryCheck();
      } catch {
        boundaryAfter = { passed: false, receiptSha256: null };
      }
      checks.boundaryPostflightExact = boundaryAfter.passed &&
        boundaryAfter.receiptSha256 !== null;
      failureCode ??= nextFailure(checks, args.operation);
    }
  }

  let outcome: "prepared" | "fenced" | "activated" |
    "failed_before_attempt" | "mutation_uncertain" =
    attempts === 0
      ? "failed_before_attempt"
      : failureCode === null
        ? args.operation === "prepare"
          ? "prepared"
          : args.operation === "fence"
            ? "fenced"
            : "activated"
        : "mutation_uncertain";
  if (attempts === 1 && intentSha !== null && before !== null) {
    const binding = {
      policySha256: AUTOMATIC_MAINTENANCE_WORKER_FENCE_POLICY_SHA256,
      candidateSha: args.candidateSha,
      target: args.target,
      operation: args.operation,
      projectId: PROJECT_ID,
      environmentId: target.environmentId,
      serviceId: SERVICE_ID,
      configuredVariables: {
        PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED: operation.enabledValue,
        PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: args.candidateSha,
      },
      skipDeploys: operation.skipDeploys,
    };
    const terminal = canonical({
      schemaVersion: AUTOMATIC_MAINTENANCE_WORKER_FENCE_TERMINAL_SCHEMA,
      executorState: AUTOMATIC_MAINTENANCE_WORKER_FENCE_EXECUTOR_STATE,
      binding,
      bindingSha256: sha256(canonical(binding)),
      outcome,
      attempts,
      retryAllowed: false,
      failureCode,
      authoritySha256: authoritySha,
      intentSha256: intentSha,
      providerEvidence: {
        graphqlOperation: "variableCollectionUpsert",
        mutationCallCount: attempts,
        acknowledgementExact: checks.acknowledgementExact,
        providerBeforeSha256: sha256(canonical(before)),
        providerAfterSha256: after === null ? null : sha256(canonical(after)),
        deploymentBeforeIdSha256: railwayDeploymentIdentityIdSha256(
          "deployment",
          before.deployment.id,
        ),
        deploymentAfterIdSha256: after === null
          ? null
          : railwayDeploymentIdentityIdSha256("deployment", after.deployment.id),
        sourceBeforeSha: before.deployment.commitHash,
        sourceAfterSha: after === null ? null : after.deployment.commitHash,
        sourcePreservedExact: after !== null &&
          after.deployment.commitHash === before.deployment.commitHash,
        deploymentIdChanged: after !== null &&
          after.deployment.id !== before.deployment.id,
        topologyBeforeSha256: sha256(topologyCanonical(before)),
        topologyAfterSha256: after === null
          ? null
          : sha256(topologyCanonical(after)),
        collateralVariablesBeforeSha256: sha256(canonical(otherRows(before))),
        collateralVariablesAfterSha256: after === null
          ? null
          : sha256(canonical(otherRows(after))),
      },
      runtimeEvidence: runtime,
      mutationBoundaryEvidence: {
        preflightReceiptSha256: boundaryBefore.receiptSha256,
        postflightReceiptSha256: boundaryAfter.receiptSha256,
      },
      checks: { ...checks, terminalEvidenceExact: true },
      stagingBootstrapVerification: {
        preparedReceiptExact: args.target === "permanent-staging" &&
          args.operation === "prepare" &&
          outcome === "prepared",
        sufficientWithoutQuiescenceProof: false,
        nextRequiredProof: "EXACT_SCALE_1_TO_0_QUIESCENCE_PROOF",
        legacySourceRuntimeFenceClaimed: false,
      },
      productionDeploymentVerification: {
        requiredReceiptFilename:
          "automatic-maintenance-worker-fence-terminal.json",
        eligible: args.target === "production" &&
          args.operation === "fence" &&
          outcome === "fenced",
        exactCandidateTargetOperationBindingRequired: true,
        bindingSha256Required: true,
        oldRuntimeSafetyPrerequisite: args.operation === "fence"
          ? "EXTERNAL_SQLITE_DETACHED_FROM_POSTGRES_PROOF"
          : null,
        oldRuntimeSafetyVerifiedByThisOperation: false,
      },
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    try {
      terminalSha = dependencies.writeDurable(
        args.evidenceDirectory,
        "automatic-maintenance-worker-fence-terminal.json",
        terminal,
      );
      checks.terminalEvidenceExact = terminalSha === sha256(terminal);
    } catch {
      checks.terminalEvidenceExact = false;
    }
    if (!checks.terminalEvidenceExact) {
      failureCode = "TERMINAL_EVIDENCE_FAILED";
      outcome = "mutation_uncertain";
    }
  }
  dependencies.writeOutput(`${JSON.stringify(fixedOutput(
    args,
    outcome,
    attempts,
    failureCode,
    authoritySha,
    intentSha,
    terminalSha,
    checks,
  ))}\n`);
  return (outcome === "prepared" || outcome === "fenced" || outcome === "activated") &&
      checks.terminalEvidenceExact
    ? 0
    : 1;
}

export async function runProtectedAutomaticMaintenanceWorkerFence(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    boundaryCheck: async () => ({ passed: false, receiptSha256: null }),
    reassertRepositoryState,
    readAuthority: readAuthorityDefault,
    readActivationPrerequisite: readActivationPrerequisiteDefault,
    parseActivationPrerequisite:
      parseProductionActivationRoleLimitPrerequisiteVerification,
    writeDurable: durableWriteDefault,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  if (!overrides.boundaryCheck) {
    (dependencies as { boundaryCheck: Dependencies["boundaryCheck"] }).boundaryCheck =
      () => defaultBoundaryCheck(dependencies.env, dependencies.fetchImpl);
  }
  const args = parseArguments(dependencies.argv);
  const checks = emptyChecks();
  checks.policyExact = policyExact(dependencies.cwd);
  if (args === null) {
    dependencies.writeOutput(`${JSON.stringify(fixedOutput(
      null,
      "failed_before_attempt",
      0,
      "ARGUMENTS_INVALID",
      null,
      null,
      null,
      checks,
    ))}\n`);
    return 1;
  }
  return args.mode === "authority"
    ? runAuthorityMode(dependencies, args, checks)
    : runMutationMode(dependencies, args, checks);
}

export const automaticMaintenanceWorkerFenceInternals = {
  authorityReceiptExact,
  confirmation,
  deploymentPart,
  metadataPart,
  parseArguments,
  policyExact,
  soleHealthyCandidate,
  targetRowsAfterExact,
  targetRowsBeforeExact,
  tokenScopeExact,
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runProtectedAutomaticMaintenanceWorkerFence();
}
