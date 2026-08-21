import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRailwayMutationBoundaryCheck } from
  "./check-railway-mutation-boundary.js";
import {
  parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse,
  parseRailwayApplicationDeploymentAttestationRuntimeResponse,
  type RailwayApplicationDeploymentAttestationProviderSnapshot,
} from "../src/lib/railway-application-deployment-attestation.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";
import {
  parseProductionScaleActivationPrerequisiteVerification,
  type ProductionScaleActivationPrerequisiteVerification,
} from "./verify-production-maintenance-role-limit-prerequisites.js";

export const PROTECTED_STAGING_SCALE_SCHEMA =
  "pintpath-permanent-staging-scale-operation/v2" as const;
export const PROTECTED_STAGING_SCALE_STATE =
  "GITHUB_ENVIRONMENT_PROTECTED" as const;

const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const PRODUCTION_ENVIRONMENT_ID = "13dab015-df74-45c6-b26f-69323daea99a";
const STAGING_ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const REGION = "asia-southeast1-eqsg3a";
const STAGING_DOMAIN = "beer-staging.up.railway.app";
const PRODUCTION_DOMAIN = "pintpath.au";
const POLICY_PATH = "ops/railway/permanent-staging-scale-evidence-policy.json";
const POLICY_SHA256 =
  "164d53a5bccff4a861c8568abebe5caa06352f64245ac7e734e55c056c2be608";
const BOUNDARY_POLICY_PATH = "ops/railway/production-staging-mutation-policy.json";
const GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const CLI_SHA256 = "27133cfc20bffc43b2f32c1638fa3c50eefc2f9d2d80301a93de34632ccb7a43";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const TOKEN_PATTERN = /^[^\r\n\0]{16,4096}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const QUERY_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 60_000;
const RECONCILIATION_TIMEOUT_MS = 5 * 60_000;
const RECONCILIATION_INTERVAL_MS = 5_000;

export const PROTECTED_STAGING_SCALE_DISCOVERY_QUERY = `query PintPathProtectedScaleDiscovery(
  $environmentId: String!
  $serviceId: String!
) {
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    latestDeployment { id }
  }
}`;

export const PROTECTED_STAGING_SCALE_SNAPSHOT_QUERY = `query PintPathProtectedScaleSnapshot(
  $environmentId: String!
  $serviceId: String!
  $deploymentId: String!
) {
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
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
  deployment(id: $deploymentId) {
    id
    projectId
    environmentId
    serviceId
    snapshotId
    meta
  }
}`;

export const PROTECTED_STAGING_SCALE_TOKEN_SCOPE_QUERY =
  `query PintPathProtectedScaleTokenScope { projectToken { projectId environmentId } }`;

type Direction =
  | "out"
  | "converge-one"
  | "converge-production-two"
  | "quiesce-staging-zero"
  | "bootstrap-staging-one";

type ReplicaCount = 0 | 1 | 2;

interface RuntimeMaintenanceExpectation {
  readonly enabled: boolean;
  readonly candidateBound: boolean;
}

interface ScaleTarget {
  readonly environmentId: string;
  readonly domain: string;
}

const STAGING_TARGET: ScaleTarget = Object.freeze({
  environmentId: STAGING_ENVIRONMENT_ID,
  domain: STAGING_DOMAIN,
});
const PRODUCTION_TARGET: ScaleTarget = Object.freeze({
  environmentId: PRODUCTION_ENVIRONMENT_ID,
  domain: PRODUCTION_DOMAIN,
});

interface CommandResult {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly boundaryCheck: () => Promise<0 | 1>;
  readonly reassertRepositoryState: (cwd: string, candidateSha: string) => boolean;
  readonly validateCli: (filename: string) => boolean;
  readonly validateProductionActivationPrerequisite: (
    source: string,
    expected: {
      readonly candidateSha: string;
      readonly currentRunId: string;
      readonly activateRunId: string;
      readonly now: Date;
    },
  ) => ProductionScaleActivationPrerequisiteVerification;
  readonly runCommand: (
    executable: string,
    args: readonly string[],
    token: string,
  ) => Promise<CommandResult>;
  readonly probeRuntime: (
    target: ScaleTarget,
    candidateSha: string,
    deploymentId: string,
    expectation: RuntimeMaintenanceExpectation,
  ) => Promise<boolean>;
  readonly probeRuntimeAbsent: (target: ScaleTarget) => Promise<boolean>;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

interface ScaleReceipt {
  readonly schemaVersion: typeof PROTECTED_STAGING_SCALE_SCHEMA;
  readonly executorState: typeof PROTECTED_STAGING_SCALE_STATE;
  readonly direction: Direction | null;
  readonly outcome:
    | "scaled"
    | "already_converged"
    | "blocked"
    | "failed_before_attempt"
    | "mutation_uncertain";
  readonly candidateSha: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly desiredReplicas: ReplicaCount | null;
  readonly deploymentIdSha256: string | null;
  readonly attempts: 0 | 1;
  readonly retryAllowed: false;
  readonly intentSha256: string | null;
  readonly terminalEvidenceSha256: string | null;
  readonly commandStdoutSha256: string | null;
  readonly commandStderrSha256: string | null;
  readonly productionActivationPrerequisite: {
    readonly runId: string;
    readonly verificationSha256: string;
    readonly terminalSha256: string;
    readonly prerequisitesSha256: string;
    readonly deploymentBeforeIdSha256: string;
    readonly deploymentAfterIdSha256: string;
  } | null;
  readonly checks: {
    policyExact: boolean;
    githubAuthorityExact: boolean;
    tokenScopesExact: boolean;
    cliExact: boolean;
    boundaryPreflightExact: boolean;
    targetPreflightExact: boolean;
    productionActivationPrerequisiteExact: boolean;
    productionActivationDeploymentContinuityExact: boolean;
    runtimePreflightExact: boolean;
    durableIntentExact: boolean;
    repositoryPrewriteReasserted: boolean;
    writeAttemptedAtMostOnce: boolean;
    acknowledgementExact: boolean;
    postflightAttempted: boolean;
    targetPostflightExact: boolean;
    runtimePostflightExact: boolean;
    candidateUnchanged: boolean;
    deploymentUnchanged: boolean;
    boundaryPostflightExact: boolean;
    terminalEvidenceExact: boolean;
    finalReceiptEvidenceExact: boolean;
  };
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key, index) => actual[index] === key);
}

function parseArguments(argv: readonly string[]): {
  readonly direction: Direction;
  readonly candidateSha: string;
  readonly expectedDeploymentSha: string;
  readonly evidenceDirectory: string;
  readonly productionActivationRunId: string | null;
  readonly productionScaleVerificationFile: string | null;
} | null {
  if (argv.length !== 6 && argv.length !== 8 && argv.length !== 12) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1]
      || values.has(argv[index]!)) return null;
    values.set(argv[index]!, argv[index + 1]!);
  }
  if ([...values.keys()].some((key) =>
    ![
      "--direction",
      "--candidate-sha",
      "--expected-deployment-sha",
      "--evidence-dir",
      "--production-activation-run-id",
      "--production-scale-verification-file",
    ].includes(key))) return null;
  const direction = values.get("--direction");
  const candidateSha = values.get("--candidate-sha") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const productionActivationRunId =
    values.get("--production-activation-run-id") ?? null;
  const productionScaleVerificationFile =
    values.get("--production-scale-verification-file") ?? null;
  if ((direction === "out" || direction === "converge-one") && argv.length === 6
    && !values.has("--expected-deployment-sha") && SHA_PATTERN.test(candidateSha)
    && path.isAbsolute(evidenceDirectory)) {
    return {
      direction,
      candidateSha,
      expectedDeploymentSha: candidateSha,
      evidenceDirectory,
      productionActivationRunId: null,
      productionScaleVerificationFile: null,
    };
  }
  const expectedDeploymentSha = values.get("--expected-deployment-sha") ?? "";
  if (!SHA_PATTERN.test(candidateSha) || !SHA_PATTERN.test(expectedDeploymentSha)
    || !path.isAbsolute(evidenceDirectory)) return null;
  if (direction === "converge-production-two") {
    const producerArgumentsExact =
      (productionActivationRunId === null
        && productionScaleVerificationFile === null)
      || (productionActivationRunId !== null
        && RUN_ID_PATTERN.test(productionActivationRunId)
        && productionScaleVerificationFile !== null
        && path.isAbsolute(productionScaleVerificationFile));
    return expectedDeploymentSha === candidateSha && producerArgumentsExact
      ? {
          direction,
          candidateSha,
          expectedDeploymentSha,
          evidenceDirectory,
          productionActivationRunId,
          productionScaleVerificationFile,
        }
      : null;
  }
  if (direction === "bootstrap-staging-one") {
    return expectedDeploymentSha === candidateSha
        && productionActivationRunId === null
        && productionScaleVerificationFile === null
      ? {
          direction,
          candidateSha,
          expectedDeploymentSha,
          evidenceDirectory,
          productionActivationRunId: null,
          productionScaleVerificationFile: null,
        }
      : null;
  }
  return direction === "quiesce-staging-zero"
    && expectedDeploymentSha !== candidateSha
    && productionActivationRunId === null
    && productionScaleVerificationFile === null
    ? {
        direction,
        candidateSha,
        expectedDeploymentSha,
        evidenceDirectory,
        productionActivationRunId: null,
        productionScaleVerificationFile: null,
      }
    : null;
}

function validateCli(filename: string): boolean {
  let bytes: Buffer | null = null;
  try {
    bytes = readTrustedRegularFile(filename, {
      minBytes: 1,
      maxBytes: 128 * 1024 * 1024,
      requireExecutable: true,
    });
    return sha256(bytes) === CLI_SHA256;
  } catch {
    return false;
  } finally {
    bytes?.fill(0);
  }
}

function readProductionActivationPrerequisite(
  filename: string,
  evidenceDirectory: string,
): string {
  if (
    !path.isAbsolute(filename)
    || path.basename(filename)
      !== "production-scale-activation-verification.json"
    || path.dirname(path.resolve(filename)) !== fs.realpathSync(evidenceDirectory)
  ) throw new Error("activation_prerequisite_invalid");
  try {
    const source = readTrustedRegularFile(filename, {
      minBytes: 2,
      maxBytes: 1024 * 1024,
      requireOwner: true,
      requirePrivate: true,
    }).toString("utf8");
    if (source.includes("\0")) throw new Error("activation_prerequisite_invalid");
    return source;
  } catch {
    throw new Error("activation_prerequisite_invalid");
  }
}

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

function durableWrite(directory: string, leaf: string, source: string): string {
  try {
    writePrivateExclusiveFile(directory, leaf, source, { requireOwner: true });
  } catch {
    throw new Error("evidence_invalid");
  }
  return sha256(source);
}

function runCommand(
  executable: string,
  args: readonly string[],
  token: string,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    const child = spawn(executable, [...args], {
      shell: false,
      detached: true,
      env: {
        HOME: "/nonexistent",
        LANG: "C",
        LC_ALL: "C",
        RAILWAY_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (
      existing: string,
      existingBytes: number,
      chunk: Buffer,
    ): readonly [string, number] => {
      if (existingBytes + chunk.length > MAX_RESPONSE_BYTES) {
        try { process.kill(-child.pid!, "SIGTERM"); } catch { /* reconciled below */ }
        return [existing, existingBytes];
      }
      return [`${existing}${chunk.toString("utf8")}`, existingBytes + chunk.length];
    };
    child.stdout.on("data", (chunk: Buffer) => {
      [stdout, stdoutBytes] = collect(stdout, stdoutBytes, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      [stderr, stderrBytes] = collect(stderr, stderrBytes, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* reconciled below */ }
    }, COMMAND_TIMEOUT_MS);
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: null,
        timedOut,
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(stderr),
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        timedOut,
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(stderr),
      });
    });
  });
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !/^application\/json(?:;|$)/i.test(
    response.headers.get("content-type") ?? "",
  )) throw new Error("provider_response_invalid");
  const source = await response.text();
  if (Buffer.byteLength(source) > MAX_RESPONSE_BYTES) {
    throw new Error("provider_response_invalid");
  }
  return JSON.parse(source) as unknown;
}

async function graphql(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  return await readJson(response);
}

function parseScope(value: unknown, environmentId = STAGING_ENVIRONMENT_ID): boolean {
  return exactKeys(value, ["data"])
    && exactKeys(value.data, ["projectToken"])
    && exactKeys(value.data.projectToken, ["projectId", "environmentId"])
    && value.data.projectToken.projectId === PROJECT_ID
    && value.data.projectToken.environmentId === environmentId;
}

function parseDiscovery(value: unknown): string | null {
  if (!exactKeys(value, ["data"])
    || !exactKeys(value.data, ["serviceInstance"])
    || !exactKeys(value.data.serviceInstance, ["latestDeployment"])
    || !exactKeys(value.data.serviceInstance.latestDeployment, ["id"])
    || typeof value.data.serviceInstance.latestDeployment.id !== "string"
    || !UUID_PATTERN.test(value.data.serviceInstance.latestDeployment.id)) return null;
  return value.data.serviceInstance.latestDeployment.id;
}

async function querySnapshot(
  fetchImpl: typeof fetch,
  token: string,
  target: ScaleTarget = STAGING_TARGET,
): Promise<RailwayApplicationDeploymentAttestationProviderSnapshot> {
  const deploymentId = parseDiscovery(await graphql(
    fetchImpl,
    token,
    PROTECTED_STAGING_SCALE_DISCOVERY_QUERY,
    { environmentId: target.environmentId, serviceId: SERVICE_ID },
  ));
  if (!deploymentId) throw new Error("provider_snapshot_invalid");
  const source = JSON.stringify(await graphql(
    fetchImpl,
    token,
    PROTECTED_STAGING_SCALE_SNAPSHOT_QUERY,
    {
      environmentId: target.environmentId,
      serviceId: SERVICE_ID,
      deploymentId,
    },
  ));
  const snapshot = parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse(
    source,
  );
  if (!snapshot) throw new Error("provider_snapshot_invalid");
  return snapshot;
}

async function probeRuntime(
  fetchImpl: typeof fetch,
  target: ScaleTarget,
  candidateSha: string,
  deploymentId: string,
  expectation: RuntimeMaintenanceExpectation,
): Promise<boolean> {
  for (const route of ["/health", "/startup", "/ready"] as const) {
    const response = await fetchImpl(`https://${target.domain}${route}`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const source = await response.text();
    if (Buffer.byteLength(source, "utf8") > MAX_RESPONSE_BYTES) return false;
    const runtime = parseRailwayApplicationDeploymentAttestationRuntimeResponse(
      route,
      source,
    );
    if (
      !runtime
      || runtime.deployment.commitSha !== candidateSha
      || runtime.deployment.projectIdSha256
        !== railwayDeploymentIdentityIdSha256("project", PROJECT_ID)
      || runtime.deployment.environmentIdSha256
        !== railwayDeploymentIdentityIdSha256("environment", target.environmentId)
      || runtime.deployment.serviceIdSha256
        !== railwayDeploymentIdentityIdSha256("service", SERVICE_ID)
      || runtime.deployment.deploymentIdSha256
        !== railwayDeploymentIdentityIdSha256("deployment", deploymentId)
      || runtime.automaticMaintenance.enabled !== expectation.enabled
      || runtime.automaticMaintenance.candidateBound !== expectation.candidateBound
    ) return false;
  }
  return true;
}

async function probeRuntimeAbsent(
  fetchImpl: typeof fetch,
  target: ScaleTarget,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  for (let round = 0; round < 3; round += 1) {
    for (const route of ["/health", "/startup", "/ready"] as const) {
      try {
        const response = await fetchImpl(`https://${target.domain}${route}`, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        });
        if (response.ok) return false;
        await response.body?.cancel();
      } catch {
        // Connection refusal and provider 5xx both confirm no healthy app route.
      }
    }
    if (round < 2) await sleep(10_000);
  }
  return true;
}

function snapshotExact(
  snapshot: RailwayApplicationDeploymentAttestationProviderSnapshot,
  candidateSha: string,
  replicas: ReplicaCount,
  target: ScaleTarget = STAGING_TARGET,
): boolean {
  return snapshot.serviceId === SERVICE_ID
    && snapshot.environmentId === target.environmentId
    && snapshot.numReplicas === replicas
    && snapshot.latestDeployment.id === snapshot.deployment.id
    && snapshot.latestDeployment.status === "SUCCESS"
    && snapshot.latestDeployment.deploymentStopped === false
    && snapshot.deployment.projectId === PROJECT_ID
    && snapshot.deployment.environmentId === target.environmentId
    && snapshot.deployment.serviceId === SERVICE_ID
    && snapshot.deployment.commitHash === candidateSha
    && snapshot.deployment.patchId === null
    && snapshot.activeDeployments.length === 1
    && snapshot.activeDeployments[0]?.id === snapshot.latestDeployment.id
    && snapshot.activeDeployments[0]?.status === "SUCCESS"
    && snapshot.activeDeployments[0]?.deploymentStopped === false
    && snapshot.domains.length === 1
    && snapshot.domains[0]?.kind === "service"
    && snapshot.domains[0].domain === target.domain
    && snapshot.domains[0].targetPort === 3000;
}

function deploymentIdentity(snapshot: RailwayApplicationDeploymentAttestationProviderSnapshot): string {
  return canonical({
    latestDeployment: snapshot.latestDeployment,
    activeDeployments: snapshot.activeDeployments,
    deployment: snapshot.deployment,
    domains: snapshot.domains,
    serviceInstanceId: snapshot.serviceInstanceId,
  });
}

async function reconcile(
  dependencies: Dependencies,
  token: string,
  candidateSha: string,
  replicas: ReplicaCount,
  target: ScaleTarget = STAGING_TARGET,
): Promise<RailwayApplicationDeploymentAttestationProviderSnapshot | null> {
  const deadline = dependencies.now() + RECONCILIATION_TIMEOUT_MS;
  do {
    try {
      const snapshot = await querySnapshot(dependencies.fetchImpl, token, target);
      if (snapshotExact(snapshot, candidateSha, replicas, target)) return snapshot;
    } catch {
      // Read-only reconciliation continues until its fixed deadline.
    }
    if (dependencies.now() >= deadline) break;
    await dependencies.sleep(RECONCILIATION_INTERVAL_MS);
  } while (dependencies.now() <= deadline);
  return null;
}

function policyExact(cwd: string): boolean {
  try {
    const source = fs.readFileSync(path.resolve(cwd, POLICY_PATH));
    if (sha256(source) !== POLICY_SHA256) return false;
    const value = JSON.parse(source.toString("utf8")) as unknown;
    return (
      exactKeys(value, [
        "schemaVersion",
        "policyId",
        "activationState",
        "projectId",
        "productionEnvironmentId",
        "stagingEnvironmentId",
        "serviceId",
        "publicOrigin",
        "region",
        "githubEnvironment",
        "requiredGitRef",
        "railwayCli",
        "lifecycle",
        "productionConvergence",
        "workerBootstrap",
        "runtimeFence",
        "evidence",
      ]) &&
      value.schemaVersion ===
        "pintpath-permanent-staging-scale-evidence-policy/v2" &&
      value.activationState === PROTECTED_STAGING_SCALE_STATE &&
      value.projectId === PROJECT_ID &&
      value.productionEnvironmentId === PRODUCTION_ENVIRONMENT_ID &&
      value.stagingEnvironmentId === STAGING_ENVIRONMENT_ID &&
      value.serviceId === SERVICE_ID &&
      value.publicOrigin === `https://${STAGING_DOMAIN}` &&
      value.region === REGION &&
      value.githubEnvironment === "permanent-staging-scale-evidence" &&
      value.requiredGitRef === "refs/heads/main" &&
      exactKeys(value.productionConvergence, [
        "environmentId",
        "publicOrigin",
        "githubEnvironment",
        "requiredReplicaCount",
        "scaleDownAllowed",
        "maximumAttempts",
        "automaticRetriesAllowed",
        "unconditionalReadOnlyPostflight",
        "exactExistingDeploymentShaRequired",
        "activationPrerequisiteRequired",
        "activationVerificationSchema",
        "activationVerificationFilename",
        "exactActivationRunBindingRequired",
        "liveDeploymentContinuityRequired",
        "durableIntentBindingRequired",
        "terminalReceiptBindingRequired",
      ]) &&
      value.productionConvergence.environmentId ===
        PRODUCTION_ENVIRONMENT_ID &&
      value.productionConvergence.publicOrigin ===
        `https://${PRODUCTION_DOMAIN}` &&
      value.productionConvergence.githubEnvironment ===
        "production-topology-configuration" &&
      value.productionConvergence.requiredReplicaCount === 2 &&
      value.productionConvergence.scaleDownAllowed === false &&
      value.productionConvergence.maximumAttempts === 1 &&
      value.productionConvergence.automaticRetriesAllowed === false &&
      value.productionConvergence.unconditionalReadOnlyPostflight === true &&
      value.productionConvergence.exactExistingDeploymentShaRequired === true &&
      value.productionConvergence.activationPrerequisiteRequired === true &&
      value.productionConvergence.activationVerificationSchema ===
        "pintpath-production-scale-activation-prerequisite/v1" &&
      value.productionConvergence.activationVerificationFilename ===
        "production-scale-activation-verification.json" &&
      value.productionConvergence.exactActivationRunBindingRequired === true &&
      value.productionConvergence.liveDeploymentContinuityRequired === true &&
      value.productionConvergence.durableIntentBindingRequired === true &&
      value.productionConvergence.terminalReceiptBindingRequired === true &&
      exactKeys(value.workerBootstrap, [
        "quiesceDirection",
        "bootstrapDirection",
        "initialReplicaCount",
        "quiescedReplicaCount",
        "restoredReplicaCount",
        "maximumAttemptsPerTransition",
        "automaticRetriesAllowed",
        "runtimeMustBeUnavailableWhileQuiesced",
        "restoredRuntimeAutomaticMaintenanceEnabled",
        "restoredRuntimeCandidateBindingRequired",
        "deploymentMustRemainUnchangedPerScale",
      ]) &&
      value.workerBootstrap.quiesceDirection === "quiesce-staging-zero" &&
      value.workerBootstrap.bootstrapDirection === "bootstrap-staging-one" &&
      value.workerBootstrap.initialReplicaCount === 1 &&
      value.workerBootstrap.quiescedReplicaCount === 0 &&
      value.workerBootstrap.restoredReplicaCount === 1 &&
      value.workerBootstrap.maximumAttemptsPerTransition === 1 &&
      value.workerBootstrap.automaticRetriesAllowed === false &&
      value.workerBootstrap.runtimeMustBeUnavailableWhileQuiesced === true &&
      value.workerBootstrap.restoredRuntimeAutomaticMaintenanceEnabled === false &&
      value.workerBootstrap.restoredRuntimeCandidateBindingRequired === true &&
      value.workerBootstrap.deploymentMustRemainUnchangedPerScale === true &&
      exactKeys(value.runtimeFence, [
        "requiredRoutes",
        "automaticMaintenanceEnabled",
        "candidateBindingRequired",
        "preflightRequired",
        "postflightRequired",
      ]) &&
      Array.isArray(value.runtimeFence.requiredRoutes) &&
      JSON.stringify(value.runtimeFence.requiredRoutes)
        === JSON.stringify(["/health", "/startup", "/ready"]) &&
      value.runtimeFence.automaticMaintenanceEnabled === true &&
      value.runtimeFence.candidateBindingRequired === true &&
      value.runtimeFence.preflightRequired === true &&
      value.runtimeFence.postflightRequired === true &&
      exactKeys(value.evidence, [
        "durableIntentRequiredBeforeEachWrite",
        "terminalEvidenceRequired",
        "finalReceiptRequired",
        "deploymentMustRemainUnchanged",
        "candidateCommitMustRemainExact",
      ]) &&
      Object.values(value.evidence).every((entry) => entry === true)
    );
  } catch {
    return false;
  }
}

function emptyChecks(): ScaleReceipt["checks"] {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    tokenScopesExact: false,
    cliExact: false,
    boundaryPreflightExact: false,
    targetPreflightExact: false,
    productionActivationPrerequisiteExact: false,
    productionActivationDeploymentContinuityExact: false,
    runtimePreflightExact: false,
    durableIntentExact: false,
    repositoryPrewriteReasserted: false,
    writeAttemptedAtMostOnce: true,
    acknowledgementExact: false,
    postflightAttempted: false,
    targetPostflightExact: false,
    runtimePostflightExact: false,
    candidateUnchanged: false,
    deploymentUnchanged: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
    finalReceiptEvidenceExact: false,
  };
}

function receipt(
  direction: Direction | null,
  outcome: ScaleReceipt["outcome"],
  candidateSha: string | null,
  startedAt: string,
  completedAt: string,
  desiredReplicas: ReplicaCount | null,
  deploymentIdSha256: string | null,
  attempts: 0 | 1,
  intentSha256: string | null,
  terminalEvidenceSha256: string | null,
  productionActivationPrerequisite:
    ScaleReceipt["productionActivationPrerequisite"],
  command: CommandResult | null,
  checks: ScaleReceipt["checks"],
): ScaleReceipt {
  return {
    schemaVersion: PROTECTED_STAGING_SCALE_SCHEMA,
    executorState: PROTECTED_STAGING_SCALE_STATE,
    direction,
    outcome,
    candidateSha,
    startedAt,
    completedAt,
    desiredReplicas,
    deploymentIdSha256,
    attempts,
    retryAllowed: false,
    intentSha256,
    terminalEvidenceSha256,
    commandStdoutSha256: command?.stdoutSha256 ?? null,
    commandStderrSha256: command?.stderrSha256 ?? null,
    productionActivationPrerequisite,
    checks,
  };
}

export async function runProtectedPermanentStagingScale(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    boundaryCheck: () => runRailwayMutationBoundaryCheck({
      argv: ["--policy", BOUNDARY_POLICY_PATH],
    }),
    reassertRepositoryState,
    validateCli,
    validateProductionActivationPrerequisite:
      parseProductionScaleActivationPrerequisiteVerification,
    runCommand,
    probeRuntime: (target, candidateSha, deploymentId, expectation) => probeRuntime(
      fetch,
      target,
      candidateSha,
      deploymentId,
      expectation,
    ),
    probeRuntimeAbsent: (target) => probeRuntimeAbsent(
      fetch,
      target,
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ),
    writeDurable: durableWrite,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const startedAt = new Date(dependencies.now()).toISOString();
  let completedAt = startedAt;
  const args = parseArguments(dependencies.argv);
  const checks = emptyChecks();
  const direction = args?.direction ?? null;
  const candidateSha = args?.candidateSha ?? null;
  const desiredReplicas = direction === "quiesce-staging-zero" ? 0
    : direction === "converge-one" || direction === "bootstrap-staging-one" ? 1
      : direction === "out" || direction === "converge-production-two" ? 2 : null;
  const target = direction === "converge-production-two" ? PRODUCTION_TARGET : STAGING_TARGET;
  let attempts: 0 | 1 = 0;
  let intentSha: string | null = null;
  let terminalSha: string | null = null;
  let command: CommandResult | null = null;
  let outcome: ScaleReceipt["outcome"] = "blocked";
  let before: RailwayApplicationDeploymentAttestationProviderSnapshot | null = null;
  let deploymentIdSha256: string | null = null;
  let metadataToken = "";
  let productionActivationVerification:
    ProductionScaleActivationPrerequisiteVerification | null = null;
  let productionActivationPrerequisite:
    ScaleReceipt["productionActivationPrerequisite"] = null;
  try {
    checks.policyExact = policyExact(dependencies.cwd);
    const confirmation = direction === "out"
      ? "SCALE_PERMANENT_STAGING_TO_TWO_FOR_EVIDENCE"
      : direction === "converge-one"
        ? "CONVERGE_PERMANENT_STAGING_TO_ONE"
        : direction === "converge-production-two"
          ? "CONVERGE_PRODUCTION_TO_TWO_REPLICAS"
          : direction === "quiesce-staging-zero"
            ? "QUIESCE_PERMANENT_STAGING_TO_ZERO_FOR_WORKER_BOOTSTRAP"
            : "RESTORE_PERMANENT_STAGING_TO_ONE_FOR_WORKER_BOOTSTRAP";
    checks.githubAuthorityExact = args !== null
      && dependencies.env.GITHUB_REF === "refs/heads/main"
      && dependencies.env.GITHUB_SHA === args.candidateSha
      && dependencies.env.PINTPATH_SCALE_CONFIRMATION === confirmation
      && (direction === "converge-one"
        || dependencies.env.GITHUB_RUN_ATTEMPT === "1");
    if (!args || !checks.policyExact || !checks.githubAuthorityExact) {
      throw new Error("authority_invalid");
    }
    const productionActivationRunId = args.productionActivationRunId
      ?? dependencies.env.PINTPATH_PRODUCTION_SCALE_ACTIVATE_RUN_ID
      ?? null;
    const productionScaleVerificationFile = args.productionScaleVerificationFile
      ?? dependencies.env.PINTPATH_PRODUCTION_SCALE_ACTIVATION_VERIFICATION_FILE
      ?? null;
    if (direction === "converge-production-two") {
      const currentRunId = dependencies.env.GITHUB_RUN_ID ?? "";
      if (
        !productionActivationRunId
        || !RUN_ID_PATTERN.test(productionActivationRunId)
        || !RUN_ID_PATTERN.test(currentRunId)
        || !productionScaleVerificationFile
      ) throw new Error("activation_prerequisite_invalid");
      try {
        const verificationSource = readProductionActivationPrerequisite(
          productionScaleVerificationFile,
          args.evidenceDirectory,
        );
        productionActivationVerification =
          dependencies.validateProductionActivationPrerequisite(
            verificationSource,
            {
              candidateSha: args.candidateSha,
              currentRunId,
              activateRunId: productionActivationRunId,
              now: new Date(dependencies.now()),
            },
          );
        productionActivationPrerequisite = {
          runId: productionActivationVerification.activation.runId,
          verificationSha256: sha256(verificationSource),
          terminalSha256:
            productionActivationVerification.activation.terminalSha256,
          prerequisitesSha256:
            productionActivationVerification.activation.prerequisitesSha256,
          deploymentBeforeIdSha256:
            productionActivationVerification.activation
              .deploymentBeforeIdSha256,
          deploymentAfterIdSha256:
            productionActivationVerification.activation.deploymentAfterIdSha256,
        };
        checks.productionActivationPrerequisiteExact =
          productionActivationPrerequisite.runId === productionActivationRunId
          && productionActivationVerification.candidateSha === args.candidateSha
          && productionActivationVerification.consumer.runId === currentRunId
          && Object.entries(productionActivationPrerequisite)
            .filter(([key]) => key !== "runId")
            .every(([, value]) => SHA256_PATTERN.test(value));
      } catch {
        throw new Error("activation_prerequisite_invalid");
      }
      if (!checks.productionActivationPrerequisiteExact) {
        throw new Error("activation_prerequisite_invalid");
      }
    } else {
      if (
        productionActivationRunId !== null
        || productionScaleVerificationFile !== null
      ) throw new Error("activation_prerequisite_invalid");
      checks.productionActivationPrerequisiteExact = true;
      checks.productionActivationDeploymentContinuityExact = true;
    }
    metadataToken = direction === "converge-production-two"
      ? dependencies.env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? ""
      : dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    const mutationToken = direction === "converge-production-two"
      ? dependencies.env.PINTPATH_RAILWAY_PRODUCTION_SCALE_TOKEN ?? ""
      : dependencies.env.PINTPATH_RAILWAY_STAGING_SCALE_TOKEN ?? "";
    const cli = dependencies.env.PINTPATH_RAILWAY_CLI_PATH ?? "";
    if (!TOKEN_PATTERN.test(metadataToken) || !TOKEN_PATTERN.test(mutationToken)
      || metadataToken === mutationToken) throw new Error("token_invalid");
    const [metadataScope, mutationScope] = await Promise.all([
      graphql(dependencies.fetchImpl, metadataToken, PROTECTED_STAGING_SCALE_TOKEN_SCOPE_QUERY, {}),
      graphql(dependencies.fetchImpl, mutationToken, PROTECTED_STAGING_SCALE_TOKEN_SCOPE_QUERY, {}),
    ]);
    checks.tokenScopesExact = parseScope(metadataScope, target.environmentId)
      && parseScope(mutationScope, target.environmentId);
    checks.cliExact = dependencies.validateCli(cli);
    checks.boundaryPreflightExact = await dependencies.boundaryCheck() === 0;
    if (!checks.tokenScopesExact || !checks.cliExact || !checks.boundaryPreflightExact) {
      throw new Error("preflight_invalid");
    }
    before = await querySnapshot(dependencies.fetchImpl, metadataToken, target);
    deploymentIdSha256 = railwayDeploymentIdentityIdSha256(
      "deployment",
      before.deployment.id,
    ) ?? null;
    if (!deploymentIdSha256) throw new Error("deployment_identity_invalid");
    if (direction === "converge-production-two") {
      checks.productionActivationDeploymentContinuityExact =
        productionActivationPrerequisite !== null
        && deploymentIdSha256
          === productionActivationPrerequisite.deploymentAfterIdSha256;
      if (!checks.productionActivationDeploymentContinuityExact) {
        throw new Error("activation_prerequisite_invalid");
      }
    }
    const beforeReplicas = before.numReplicas;
    checks.targetPreflightExact = direction === "out"
      ? snapshotExact(before, args.expectedDeploymentSha, 1, target)
      : direction === "quiesce-staging-zero"
        ? snapshotExact(before, args.expectedDeploymentSha, 1, target)
        : direction === "bootstrap-staging-one"
          ? snapshotExact(before, args.expectedDeploymentSha, 0, target)
          : (beforeReplicas === 1 || beforeReplicas === 2)
            && snapshotExact(
              before,
              args.expectedDeploymentSha,
              beforeReplicas as 1 | 2,
              target,
            );
    if (!checks.targetPreflightExact) throw new Error("target_invalid");
    checks.runtimePreflightExact = direction === "quiesce-staging-zero"
      ? true
      : direction === "bootstrap-staging-one"
        ? await dependencies.probeRuntimeAbsent(target)
        : await dependencies.probeRuntime(
          target,
          args.expectedDeploymentSha,
          before.deployment.id,
          { enabled: true, candidateBound: true },
        );
    if (!checks.runtimePreflightExact) throw new Error("runtime_fence_invalid");
    if ((direction === "converge-one" && beforeReplicas === 1)
      || (direction === "converge-production-two" && beforeReplicas === 2)) {
      checks.repositoryPrewriteReasserted = dependencies.reassertRepositoryState(
        dependencies.cwd,
        args.candidateSha,
      );
      if (!checks.repositoryPrewriteReasserted) {
        throw new Error("repository_prewrite_drift");
      }
      checks.acknowledgementExact = true;
      checks.postflightAttempted = true;
      checks.targetPostflightExact = true;
      checks.runtimePostflightExact = checks.runtimePreflightExact;
      checks.candidateUnchanged = true;
      checks.deploymentUnchanged = true;
      checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
      outcome = checks.boundaryPostflightExact ? "already_converged" : "mutation_uncertain";
    } else {
      const intent = canonical({
        schemaVersion: "pintpath-permanent-staging-scale-intent/v1",
        direction,
        candidateSha: args.candidateSha,
        expectedDeploymentSha: args.expectedDeploymentSha,
        projectId: PROJECT_ID,
        environmentId: target.environmentId,
        serviceId: SERVICE_ID,
        region: REGION,
        beforeReplicas,
        desiredReplicas,
        productionActivationPrerequisite,
        maximumAttempts: 1,
        retryAllowed: false,
        beforeDeploymentSha256: sha256(deploymentIdentity(before)),
      });
      intentSha = dependencies.writeDurable(
        args.evidenceDirectory,
        `${direction}-intent.json`,
        intent,
      );
      checks.durableIntentExact = intentSha === sha256(intent);
      if (!checks.durableIntentExact) throw new Error("intent_invalid");
      checks.repositoryPrewriteReasserted = dependencies.reassertRepositoryState(
        dependencies.cwd,
        args.candidateSha,
      );
      if (!checks.repositoryPrewriteReasserted) {
        throw new Error("repository_prewrite_drift");
      }

      let runtimePrewriteExact = direction === "quiesce-staging-zero";
      try {
        runtimePrewriteExact = direction === "quiesce-staging-zero"
          ? true
          : direction === "bootstrap-staging-one"
            ? await dependencies.probeRuntimeAbsent(target)
            : await dependencies.probeRuntime(
                target,
                args.expectedDeploymentSha,
                before.deployment.id,
                { enabled: true, candidateBound: true },
              );
      } catch {
        runtimePrewriteExact = false;
      }
      checks.runtimePreflightExact = checks.runtimePreflightExact && runtimePrewriteExact;
      if (!checks.runtimePreflightExact) throw new Error("runtime_prewrite_drift");

      let prewrite: RailwayApplicationDeploymentAttestationProviderSnapshot | null = null;
      try {
        prewrite = await querySnapshot(dependencies.fetchImpl, metadataToken, target);
      } catch {
        prewrite = null;
      }
      checks.targetPreflightExact = checks.targetPreflightExact
        && prewrite !== null
        && canonical(prewrite) === canonical(before)
        && snapshotExact(
          prewrite,
          args.expectedDeploymentSha,
          beforeReplicas as ReplicaCount,
          target,
        );
      if (direction === "converge-production-two") {
        const prewriteDeploymentIdSha256 = prewrite === null
          ? null
          : railwayDeploymentIdentityIdSha256("deployment", prewrite.deployment.id);
        checks.productionActivationDeploymentContinuityExact =
          checks.productionActivationDeploymentContinuityExact
          && productionActivationPrerequisite !== null
          && prewriteDeploymentIdSha256
            === productionActivationPrerequisite.deploymentAfterIdSha256;
      }
      if (!checks.targetPreflightExact
        || !checks.productionActivationDeploymentContinuityExact) {
        throw new Error("provider_prewrite_drift");
      }

      attempts = 1;
      command = await dependencies.runCommand(cli, [
        "service", "scale", `${REGION}=${desiredReplicas}`,
        "--project", PROJECT_ID,
        "--environment", target.environmentId,
        "--service", SERVICE_ID,
        "--json",
      ], mutationToken);
      checks.acknowledgementExact = command.code === 0 && command.timedOut === false;
      checks.postflightAttempted = true;
      const after = await reconcile(
        dependencies,
        metadataToken,
        args.expectedDeploymentSha,
        desiredReplicas!,
        target,
      );
      checks.targetPostflightExact = after !== null;
      checks.runtimePostflightExact = after !== null && (
        direction === "quiesce-staging-zero"
          ? await dependencies.probeRuntimeAbsent(target)
          : await dependencies.probeRuntime(
            target,
            args.expectedDeploymentSha,
            after.deployment.id,
            direction === "bootstrap-staging-one"
              ? { enabled: false, candidateBound: true }
              : { enabled: true, candidateBound: true },
          )
      );
      checks.candidateUnchanged = after?.deployment.commitHash === args.expectedDeploymentSha;
      checks.deploymentUnchanged = after !== null
        && deploymentIdentity(before) === deploymentIdentity(after);
      try {
        checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
      } catch {
        checks.boundaryPostflightExact = false;
      }
      outcome = checks.acknowledgementExact && checks.targetPostflightExact
        && checks.candidateUnchanged && checks.deploymentUnchanged
        && checks.runtimePreflightExact && checks.runtimePostflightExact
        && checks.boundaryPostflightExact && checks.repositoryPrewriteReasserted
        ? "scaled"
        : "mutation_uncertain";
    }
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  } finally {
    if (attempts === 1 && !checks.postflightAttempted && args && desiredReplicas !== null) {
      checks.postflightAttempted = true;
      const after = await reconcile(
        dependencies,
        metadataToken,
        args.expectedDeploymentSha,
        desiredReplicas,
        target,
      );
      checks.targetPostflightExact = after !== null;
      checks.runtimePostflightExact = after !== null && (
        direction === "quiesce-staging-zero"
          ? await dependencies.probeRuntimeAbsent(target)
          : await dependencies.probeRuntime(
            target,
            args.expectedDeploymentSha,
            after.deployment.id,
            direction === "bootstrap-staging-one"
              ? { enabled: false, candidateBound: true }
              : { enabled: true, candidateBound: true },
          )
      );
      checks.candidateUnchanged = after?.deployment.commitHash === args.expectedDeploymentSha;
      checks.deploymentUnchanged = before !== null && after !== null
        && deploymentIdentity(before) === deploymentIdentity(after);
    }
    if (checks.boundaryPreflightExact && !checks.boundaryPostflightExact) {
      try {
        checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
      } catch {
        checks.boundaryPostflightExact = false;
      }
    }
  }
  completedAt = new Date(dependencies.now()).toISOString();
  let provisional = receipt(
    direction,
    outcome,
    candidateSha,
    startedAt,
    completedAt,
    desiredReplicas,
    deploymentIdSha256,
    attempts,
    intentSha,
    null,
    productionActivationPrerequisite,
    command,
    checks,
  );
  if (args && (checks.durableIntentExact || outcome === "already_converged")) {
    try {
      const terminal = canonical({
        schemaVersion: "pintpath-permanent-staging-scale-terminal/v1",
        receipt: provisional,
      });
      terminalSha = dependencies.writeDurable(
        args.evidenceDirectory,
        `${args.direction}-terminal.json`,
        terminal,
      );
      checks.terminalEvidenceExact = terminalSha === sha256(terminal);
    } catch {
      checks.terminalEvidenceExact = false;
      if (attempts === 1) outcome = "mutation_uncertain";
    }
  }
  const finalReceipt = receipt(
    direction,
    outcome,
    candidateSha,
    startedAt,
    completedAt,
    desiredReplicas,
    deploymentIdSha256,
    attempts,
    intentSha,
    terminalSha,
    productionActivationPrerequisite,
    command,
    checks,
  );
  let durableReceipt = finalReceipt;
  if (args && checks.terminalEvidenceExact) {
    try {
      checks.finalReceiptEvidenceExact = true;
      durableReceipt = receipt(
        direction,
        outcome,
        candidateSha,
        startedAt,
        completedAt,
        desiredReplicas,
        deploymentIdSha256,
        attempts,
        intentSha,
        terminalSha,
        productionActivationPrerequisite,
        command,
        checks,
      );
      const source = canonical(durableReceipt);
      checks.finalReceiptEvidenceExact = dependencies.writeDurable(
        args.evidenceDirectory,
        `${args.direction}-receipt.json`,
        source,
      ) === sha256(source);
    } catch {
      checks.finalReceiptEvidenceExact = false;
    }
  }
  if (!checks.finalReceiptEvidenceExact) {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  }
  durableReceipt = receipt(
    direction,
    outcome,
    candidateSha,
    startedAt,
    completedAt,
    desiredReplicas,
    deploymentIdSha256,
    attempts,
    intentSha,
    terminalSha,
    productionActivationPrerequisite,
    command,
    checks,
  );
  dependencies.writeOutput(`${JSON.stringify(durableReceipt)}\n`);
  return (outcome === "scaled" || outcome === "already_converged")
    && checks.runtimePreflightExact && checks.runtimePostflightExact
    && checks.terminalEvidenceExact && checks.finalReceiptEvidenceExact ? 0 : 1;
}

export const protectedPermanentStagingScaleInternals = {
  deploymentIdentity,
  parseArguments,
  parseDiscovery,
  parseScope,
  snapshotExact,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedPermanentStagingScale();
}
