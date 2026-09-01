import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { URL } from "node:url";

import { z } from "zod";

import { runRailwayMutationBoundaryCheck } from
  "../check-railway-mutation-boundary.js";
import {
  parseRailwayApplicationDeploymentAttestationEmptyPatchResponse,
  parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse,
  parseRailwayApplicationDeploymentAttestationRuntimeResponse,
  parseRailwayApplicationDeploymentAttestationTokenScopeResponse,
  type RailwayApplicationDeploymentAttestationProviderSnapshot,
  type RailwayApplicationDeploymentAttestationRuntimeResponse,
} from "../../src/lib/railway-application-deployment-attestation.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../../src/lib/railway-deployment-identity.js";
import {
  parseProductionDeploymentWorkerFencePrerequisiteVerification,
  type ProductionDeploymentWorkerFencePrerequisiteVerification,
} from "../verify-production-maintenance-role-limit-prerequisites.js";
import { readTrustedRegularFile } from "./trusted-filesystem.js";

export const PERMANENT_STAGING_APP_DEPLOYMENT_POLICY_SCHEMA =
  "pintpath-railway-application-deployment-policy/v5" as const;
export const PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA =
  "pintpath-railway-application-deployment-executor/v5" as const;
export const PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION =
  "pintpath-railway-application-source-upload" as const;
export const PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE =
  "GITHUB_ENVIRONMENT_PROTECTED" as const;
export const PERMANENT_STAGING_APP_DEPLOYMENT_FAILURE_CODES = Object.freeze([
  "argument_invalid",
  "boundary_policy_drift",
  "boundary_postflight_failed",
  "boundary_preflight_failed",
  "candidate_preexisting_not_healthy",
  "cli_invalid",
  "collateral_invalid",
  "cost_policy_invalid",
  "evidence_directory_unsafe",
  "evidence_exists",
  "evidence_leaf_invalid",
  "git_autodeploy_active",
  "github_authority_failed",
  "metadata_token_missing",
  "policy_invalid",
  "prerequisite_failed",
  "provider_query_failed",
  "provider_target_mismatch",
  "reconciliation_failed",
  "runtime_probe_failed",
  "source_authority_failed",
  "source_cleanup_failed",
  "source_reassertion_failed",
  "source_snapshot_invalid",
  "target_postflight_failed",
  "target_preflight_failed",
  "terminal_evidence_failed",
  "terminal_validation_failed",
  "unexpected_failure",
  "write_token_missing",
  "write_token_scope_invalid",
  "worker_fence_prerequisite_failed",
] as const);

export type PermanentStagingAppDeploymentFailureCode =
  typeof PERMANENT_STAGING_APP_DEPLOYMENT_FAILURE_CODES[number];

const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_TOKEN_PATTERN = /^[^\r\n\0]{16,4096}$/;
const SAFE_FAILURE_CODE_SET = new Set<string>(
  PERMANENT_STAGING_APP_DEPLOYMENT_FAILURE_CODES,
);
const MAX_PROVIDER_BYTES = 1024 * 1024;
const GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const RUNTIME_ROUTES = ["/health", "/startup", "/ready"] as const;
const RAILWAY_APPLICATION_DEPLOYMENT_TOKEN_SCOPE_QUERY =
  `query PintPathRailwayApplicationDeploymentTokenScope {
  projectToken { projectId environmentId }
}` as const;
const RAILWAY_APPLICATION_DEPLOYMENT_EMPTY_PATCH_QUERY =
  `query PintPathRailwayApplicationDeploymentEmptyPatch(
  $projectId: String!
  $environmentId: String!
) {
  environment(id: $environmentId, projectId: $projectId) { id }
  staged: environmentStagedChanges(environmentId: $environmentId) {
    environmentId
    patch(decryptVariables: false)
  }
}` as const;
const RAILWAY_APPLICATION_DEPLOYMENT_DISCOVERY_QUERY =
  `query PintPathRailwayApplicationDeploymentDiscovery(
  $environmentId: String!
  $serviceId: String!
) {
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    latestDeployment { id }
  }
}` as const;
const RAILWAY_APPLICATION_DEPLOYMENT_SNAPSHOT_QUERY =
  `query PintPathRailwayApplicationDeploymentSnapshot(
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
}` as const;
const RAILWAY_APPLICATION_DEPLOYMENT_COLLATERAL_QUERY =
  `query PintPathRailwayApplicationDeploymentCollateral(
  $projectId: String!
  $environmentId: String!
  $variablesAfter: String
  $volumeInstancesAfter: String
  $serviceInstancesAfter: String
) {
  environment(id: $environmentId, projectId: $projectId) {
    id
    variables(first: 100, after: $variablesAfter) {
      edges { node { id name environmentId serviceId isSealed references } }
      pageInfo { hasNextPage endCursor }
    }
    volumeInstances(first: 100, after: $volumeInstancesAfter) {
      edges { node { serviceId environmentId volume { id } } }
      pageInfo { hasNextPage endCursor }
    }
    serviceInstances(first: 100, after: $serviceInstancesAfter) {
      edges {
        node {
          id
          serviceId
          serviceName
          environmentId
          numReplicas
          source { repo image }
          domains {
            serviceDomains { id domain targetPort }
            customDomains { id domain targetPort }
          }
          cronSchedule
          startCommand
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}` as const;

type DeploymentTarget = "permanent-staging" | "production";

const TARGET_LOCKS = Object.freeze({
  "permanent-staging": Object.freeze({
    policyId: "pintpath-permanent-staging-app-source-upload",
    fencedPolicyId: "pintpath-permanent-staging-fenced-app-source-upload",
    environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    forbiddenEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
    publicOrigin: "https://beer-staging.up.railway.app",
    publicOriginSha256:
      "fd458490dc9821b10681db486f980de7ec0d8b684f5dce4f7a5659a582df2910",
    allowedReplicaCounts: Object.freeze([1] as const),
    fencedAllowedReplicaCounts: Object.freeze([0] as const),
    githubEnvironment: "permanent-staging-deployment",
    allowedAutomaticMaintenanceStates: Object.freeze([false, true] as const),
  }),
  production: Object.freeze({
    policyId: "pintpath-production-app-source-upload",
    environmentId: "13dab015-df74-45c6-b26f-69323daea99a",
    forbiddenEnvironmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    publicOrigin: "https://pintpath.au",
    publicOriginSha256:
      "a3a1a2e58fa4038b741e1c213af02708e09ae901005c7c31f919e0a4dea46e90",
    allowedReplicaCounts: Object.freeze([1, 2] as const),
    githubEnvironment: "production-deployment",
    automaticMaintenanceEnabled: false,
  }),
} as const);

const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5" as const;
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0" as const;
const RAILWAY_CONFIG_SHA256 =
  "2b62fd2b216fb8d404b15768aa02441dc453648bc8596e04d6993da62d1d98fa" as const;
const PACKAGE_LOCK_SHA256 =
  "b5bfc2258853ab58dd5749b91ae55d9724620e102fe55e91de31a4599ab9f67b" as const;
const MUTATION_BOUNDARY_POLICY_SHA256 =
  "a61ccb5493bbb15e37c8b158f441219b4540937d9dd0ab46ddc0a0cf0be84079" as const;
const RAILWAY_CLI_VERSION = "5.32.0" as const;
const RAILWAY_CLI_ARCHIVE_SHA256 =
  "cd69b2ecb556601751165d85ac31a5fbc38cff46397939356df28d2b96a005f5" as const;
const RAILWAY_CLI_EXECUTABLE_SHA256 =
  "27133cfc20bffc43b2f32c1638fa3c50eefc2f9d2d80301a93de34632ccb7a43" as const;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const uuidSchema = z.string().regex(UUID_PATTERN);
const targetSchema = z.enum(["permanent-staging", "production"]);

const policySchema = z.object({
  schemaVersion: z.literal(PERMANENT_STAGING_APP_DEPLOYMENT_POLICY_SCHEMA),
  policyId: z.string().min(1).max(128),
  activationState: z.literal(PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE),
  projectId: uuidSchema,
  target: z.object({
    name: targetSchema,
    environmentId: uuidSchema,
    forbiddenEnvironmentId: uuidSchema,
    serviceId: uuidSchema,
    publicOrigin: z.string().url(),
    publicOriginSha256: sha256Schema,
    allowedReplicaCounts: z.union([
      z.tuple([z.literal(0)]),
      z.tuple([z.literal(1)]),
      z.tuple([z.literal(1), z.literal(2)]),
    ]),
    githubEnvironment: z.string().regex(/^[a-z0-9-]{1,80}$/),
    requiredGitRef: z.literal("refs/heads/main"),
  }).strict(),
  railwayCli: z.object({
    version: z.literal(RAILWAY_CLI_VERSION),
    platform: z.literal("linux"),
    architecture: z.literal("x64"),
    targetTriple: z.literal("x86_64-unknown-linux-musl"),
    releaseUrl: z.literal(
      "https://github.com/railwayapp/cli/releases/download/v5.32.0/railway-v5.32.0-x86_64-unknown-linux-musl.tar.gz",
    ),
    archiveSha256: z.literal(RAILWAY_CLI_ARCHIVE_SHA256),
    executableRelativePath: z.literal("railway"),
    executableSha256: z.literal(RAILWAY_CLI_EXECUTABLE_SHA256),
  }).strict(),
  sourceContract: z.object({
    candidateBinding: z.literal("exact-current-main-head"),
    cleanCommittedHeadRequired: z.literal(true),
    privateGitArchiveSnapshotRequired: z.literal(true),
    railwayConfigPath: z.literal("railway.toml"),
    railwayConfigSha256: z.literal(RAILWAY_CONFIG_SHA256),
    packageLockPath: z.literal("package-lock.json"),
    packageLockSha256: z.literal(PACKAGE_LOCK_SHA256),
  }).strict(),
  mutationBoundary: z.object({
    policyPath: z.literal("ops/railway/production-staging-mutation-policy.json"),
    policySha256: z.literal(MUTATION_BOUNDARY_POLICY_SHA256),
    immediatePreflightRequired: z.literal(true),
    unconditionalPostflightRequired: z.literal(true),
  }).strict(),
  writeContract: z.object({
    mode: z.literal("single-source-upload"),
    transportImplemented: z.literal(true),
    exactTargetTokenScopeRequired: z.literal(true),
    maximumWriteAttempts: z.literal(1),
    automaticRetryAllowed: z.literal(false),
    acknowledgementRequiredForReconciliation: z.literal(false),
    uncertainMutationAction: z.literal("READ_ONLY_RECONCILIATION_NO_RETRY"),
    exactArguments: z.tuple([
      z.literal("up"),
      z.literal("<snapshot>"),
      z.literal("--path-as-root"),
      z.literal("--no-gitignore"),
      z.literal("--detach"),
      z.literal("--json"),
      z.literal("--project"),
      z.literal("<project-id>"),
      z.literal("--environment"),
      z.literal("<environment-id>"),
      z.literal("--service"),
      z.literal("<service-id>"),
      z.literal("--message"),
      z.literal("<candidate-bound-message>"),
    ]),
    adjacentMutationAllowed: z.literal(false),
    topologyMutationAllowed: z.literal(false),
  }).strict(),
  postflightContract: z.object({
    expectedDeploymentStatus: z.literal("SUCCESS"),
    expectedDeploymentStopped: z.literal(false),
    deploymentPatchAllowed: z.literal(false),
    replicaCountMustMatchPreflight: z.literal(true),
    runtimeProbeRequired: z.boolean(),
    requiredRuntimeRoutes: z.tuple([
      z.literal("/health"),
      z.literal("/startup"),
      z.literal("/ready"),
    ]),
    automaticMaintenanceEnabled: z.boolean(),
    automaticMaintenanceCandidateBindingRequired: z.literal(true),
    maximumObservationSeconds: z.number().int().min(60).max(1_800),
    pollIntervalSeconds: z.number().int().min(2).max(30),
  }).strict(),
  prerequisite: z.union([
    z.null(),
    z.object({
      target: z.literal("permanent-staging"),
      environmentId: z.literal(
        TARGET_LOCKS["permanent-staging"].environmentId,
      ),
      serviceId: z.literal(SERVICE_ID),
      publicOrigin: z.literal(TARGET_LOCKS["permanent-staging"].publicOrigin),
      publicOriginSha256: z.literal(
        TARGET_LOCKS["permanent-staging"].publicOriginSha256,
      ),
      expectedReplicaCount: z.literal(1),
      sameCandidateRequired: z.literal(true),
    }).strict(),
  ]),
  providerReadinessContract: z.union([
    z.null(),
    z.object({
      envelopeSchema: z.literal(
        "pintpath-production-provider-readiness-envelope/v2",
      ),
      verificationSchema: z.literal(
        "pintpath-production-provider-readiness-verification/v2",
      ),
      readinessProfile: z.literal("production_free_launch"),
      maximumAgeSeconds: z.literal(86_400),
      candidateBindingRequired: z.literal(true),
      allChecksPassRequired: z.literal(true),
    }).strict(),
  ]),
  workerFencePrerequisiteContract: z.object({
    required: z.literal(true),
    verificationSchema: z.literal(
      "pintpath-production-deployment-worker-fence-prerequisite/v1",
    ),
    verificationFilename: z.literal(
      "production-deployment-worker-fence-verification.json",
    ),
    exactFenceRunBindingRequired: z.literal(true),
    liveDeploymentContinuityRequired: z.literal(true),
    durableIntentBindingRequired: z.literal(true),
    terminalReceiptBindingRequired: z.literal(true),
  }).strict().optional(),
  costContract: z.object({
    required: z.boolean(),
    policySchema: z.union([
      z.null(),
      z.literal("pintpath-permanent-staging-cost-policy/v2"),
    ]),
    policyId: z.union([
      z.null(),
      z.literal("pintpath-permanent-staging-recurring-cost"),
    ]),
    policyPath: z.union([z.null(), z.string().min(1).max(256)]),
    policySha256: z.union([z.null(), sha256Schema]),
    deploymentMayClaimCostGatePassed: z.literal(false),
    singleCombinedReceiptRequiredForRelease: z.boolean(),
    receiptMayAuthorizeDeployment: z.literal(false),
  }).strict(),
}).strict();

export type PermanentStagingAppDeploymentPolicy = z.infer<typeof policySchema>;

export const PERMANENT_STAGING_APP_DEPLOYMENT_LOCK = Object.freeze({
  schemaVersion: PERMANENT_STAGING_APP_DEPLOYMENT_POLICY_SCHEMA,
  operation: PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION,
  activationState: PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE,
  projectId: PROJECT_ID,
  serviceId: SERVICE_ID,
  targets: TARGET_LOCKS,
  railwayCli: Object.freeze({
    version: RAILWAY_CLI_VERSION,
    archiveSha256: RAILWAY_CLI_ARCHIVE_SHA256,
    executableSha256: RAILWAY_CLI_EXECUTABLE_SHA256,
  }),
  sourceContract: Object.freeze({
    railwayConfigSha256: RAILWAY_CONFIG_SHA256,
    packageLockSha256: PACKAGE_LOCK_SHA256,
  }),
  mutationBoundaryPolicySha256: MUTATION_BOUNDARY_POLICY_SHA256,
} as const);

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.port === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.origin === value;
  } catch {
    return false;
  }
}

function policyMatchesLock(policy: PermanentStagingAppDeploymentPolicy): boolean {
  const lock = TARGET_LOCKS[policy.target.name];
  let policyIdExact: boolean;
  let automaticMaintenanceStateAllowed: boolean;
  let expectedReplicaCounts: readonly number[];
  if (policy.target.name === "permanent-staging") {
    const stagingLock = TARGET_LOCKS["permanent-staging"];
    policyIdExact = policy.policyId === (
      policy.postflightContract.automaticMaintenanceEnabled
        ? stagingLock.policyId
        : stagingLock.fencedPolicyId
    );
    automaticMaintenanceStateAllowed = (
      stagingLock.allowedAutomaticMaintenanceStates as readonly boolean[]
    ).includes(policy.postflightContract.automaticMaintenanceEnabled);
    if (policy.postflightContract.automaticMaintenanceEnabled
      !== policy.postflightContract.runtimeProbeRequired) return false;
    expectedReplicaCounts = policy.postflightContract.automaticMaintenanceEnabled
      ? stagingLock.allowedReplicaCounts
      : stagingLock.fencedAllowedReplicaCounts;
  } else {
    const productionLock = TARGET_LOCKS.production;
    policyIdExact = policy.policyId === productionLock.policyId;
    automaticMaintenanceStateAllowed =
      policy.postflightContract.automaticMaintenanceEnabled
        === productionLock.automaticMaintenanceEnabled;
    if (!policy.postflightContract.runtimeProbeRequired) return false;
    expectedReplicaCounts = productionLock.allowedReplicaCounts;
  }
  return policyIdExact
    && policy.projectId === PROJECT_ID
    && policy.target.environmentId === lock.environmentId
    && policy.target.forbiddenEnvironmentId === lock.forbiddenEnvironmentId
    && policy.target.environmentId !== policy.target.forbiddenEnvironmentId
    && policy.target.serviceId === SERVICE_ID
    && policy.target.publicOrigin === lock.publicOrigin
    && policy.target.publicOriginSha256 === lock.publicOriginSha256
    && sha256(policy.target.publicOrigin) === lock.publicOriginSha256
    && exactOrigin(policy.target.publicOrigin)
    && policy.target.allowedReplicaCounts.length
      === expectedReplicaCounts.length
    && policy.target.allowedReplicaCounts.every((count, index) =>
      count === expectedReplicaCounts[index])
    && policy.target.githubEnvironment === lock.githubEnvironment
    && automaticMaintenanceStateAllowed
    && (policy.target.name === "production") === (policy.prerequisite !== null)
    && (policy.target.name === "production")
      === (policy.providerReadinessContract !== null)
    && (policy.target.name === "production")
      === (policy.workerFencePrerequisiteContract !== undefined)
    && (policy.target.name === "permanent-staging") === policy.costContract.required
    && (policy.costContract.required
      ? policy.costContract.policySchema
          === "pintpath-permanent-staging-cost-policy/v2"
        && policy.costContract.policyId
          === "pintpath-permanent-staging-recurring-cost"
        && policy.costContract.policyPath !== null
        && policy.costContract.policySha256 !== null
        && policy.costContract.singleCombinedReceiptRequiredForRelease
      : policy.costContract.policySchema === null
        && policy.costContract.policyId === null
        && policy.costContract.policyPath === null
        && policy.costContract.policySha256 === null
        && !policy.costContract.singleCombinedReceiptRequiredForRelease);
}

export function parsePermanentStagingAppDeploymentPolicy(
  source: unknown,
): PermanentStagingAppDeploymentPolicy | null {
  if (
    typeof source !== "string"
    || Buffer.byteLength(source, "utf8") > 64 * 1024
    || source.includes("\0")
  ) return null;
  try {
    const raw: unknown = JSON.parse(source);
    const policy = policySchema.parse(raw);
    if (canonicalJson(policy) !== source || !policyMatchesLock(policy)) return null;
    return Object.freeze(policy);
  } catch {
    return null;
  }
}

export const PERMANENT_STAGING_APP_DEPLOYMENT_CANONICAL_POLICY_SOURCE =
  fs.existsSync(path.resolve("ops/railway/permanent-staging-app-deployment-policy.json"))
    ? fs.readFileSync(
      path.resolve("ops/railway/permanent-staging-app-deployment-policy.json"),
      "utf8",
    )
    : "";

interface CommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

interface SourceAuthority {
  readonly candidateSha: string;
  readonly treeSha: string;
  readonly archiveSha256: string;
  readonly snapshotManifestSha256: string;
  readonly snapshotPath: string;
  readonly deploymentPath: string;
  readonly close: () => void;
  readonly cleanup: () => void;
  readonly reassert: () => void;
}

interface HeldSnapshotRoot {
  readonly authorityPath: string;
  readonly assertExact: () => void;
  readonly close: () => void;
}

interface CliAuthority {
  readonly executablePath: string;
  readonly assertExact: () => void;
  readonly close: () => void;
}

interface ProviderObservation {
  readonly tokenScopeExact: boolean;
  readonly patchEmpty: boolean;
  readonly gitAutodeployAbsent: boolean;
  readonly collateralSha256: string;
  readonly snapshot: RailwayApplicationDeploymentAttestationProviderSnapshot;
}

interface RuntimeObservation {
  readonly health: RailwayApplicationDeploymentAttestationRuntimeResponse;
  readonly startup: RailwayApplicationDeploymentAttestationRuntimeResponse;
  readonly ready: RailwayApplicationDeploymentAttestationRuntimeResponse;
}

interface BoundaryObservation {
  readonly ok: boolean;
  readonly source: string;
}

interface ExecutorDependencies {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly fetchImpl: typeof fetch;
  readonly runCommand: (
    executable: string,
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
      readonly maximumOutputBytes: number;
    },
  ) => Promise<CommandResult>;
  readonly createSourceAuthority: (
    cwd: string,
    candidateSha: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<SourceAuthority>;
  readonly validateCli: (
    policy: PermanentStagingAppDeploymentPolicy,
    dependencies: ExecutorDependencies,
  ) => Promise<CliAuthority>;
  readonly validateWriteToken: (
    policy: PermanentStagingAppDeploymentPolicy,
    token: string,
  ) => Promise<boolean>;
  readonly validateProductionWorkerFencePrerequisite: (
    source: string,
    expected: {
      readonly candidateSha: string;
      readonly currentRunId: string;
      readonly fenceRunId: string;
      readonly now: Date;
    },
  ) => ProductionDeploymentWorkerFencePrerequisiteVerification;
  readonly queryTarget: (
    policy: PermanentStagingAppDeploymentPolicy,
    environmentId: string,
    expectedReplicaCounts: readonly number[],
    publicOrigin: string,
    token: string,
  ) => Promise<ProviderObservation>;
  readonly probeRuntime: (
    origin: string,
    candidateSha: string,
    policy: PermanentStagingAppDeploymentPolicy,
    environmentId: string,
    deploymentId: string,
  ) => Promise<RuntimeObservation>;
  readonly runBoundary: (
    policy: PermanentStagingAppDeploymentPolicy,
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<BoundaryObservation>;
  readonly writeOutput: (value: string) => void;
}

export interface PermanentStagingAppDeploymentExecutorChecks {
  policyExact: boolean;
  githubMainExact: boolean;
  sourceAuthorityExact: boolean;
  cliExact: boolean;
  writeTokenScopeExact: boolean;
  costPolicyExact: boolean;
  prerequisiteExact: boolean;
  workerFencePrerequisiteExact: boolean;
  workerFenceDeploymentContinuityExact: boolean;
  boundaryPreflightExact: boolean;
  targetPreflightExact: boolean;
  gitAutodeployAbsent: boolean;
  collateralInventoryExact: boolean;
  durableIntentExact: boolean;
  sourceReasserted: boolean;
  writeAttemptedAtMostOnce: boolean;
  targetPostflightAttempted: boolean;
  targetPostflightExact: boolean;
  reconciliationCompleted: boolean;
  topologyPreserved: boolean;
  deploymentExact: boolean;
  runtimeHealthExact: boolean;
  runtimeStartupExact: boolean;
  runtimeReadinessExact: boolean;
  collateralStateUnchanged: boolean;
  boundaryPostflightExact: boolean;
  terminalEvidenceExact: boolean;
}

export interface PermanentStagingAppDeploymentExecutorReceipt {
  readonly schemaVersion: typeof PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA;
  readonly operation: typeof PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION;
  readonly executorState: typeof PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE;
  readonly target: DeploymentTarget | null;
  readonly outcome:
    | "deployed"
    | "already_deployed"
    | "reconciled_success"
    | "blocked"
    | "mutation_uncertain";
  readonly failureCode: PermanentStagingAppDeploymentFailureCode | null;
  readonly candidateSha: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly writeAttempts: 0 | 1;
  readonly acknowledgement: "not_attempted" | "received" | "missing_or_failed";
  readonly previousDeploymentIdSha256: string | null;
  readonly deploymentIdSha256: string | null;
  readonly intentSha256: string | null;
  readonly cliOutputSha256: string | null;
  readonly boundaryPreflightSha256: string | null;
  readonly boundaryPostflightSha256: string | null;
  readonly collateralSnapshotSha256s: {
    readonly before: string | null;
    readonly after: string | null;
  };
  readonly replicaCounts: {
    readonly before: number | null;
    readonly after: number | null;
  };
  readonly runtimeResponseSha256s: {
    readonly health: string | null;
    readonly startup: string | null;
    readonly ready: string | null;
  };
  readonly workerFencePrerequisite: {
    readonly runId: string;
    readonly verificationSha256: string;
    readonly bindingSha256: string;
    readonly terminalSha256: string;
    readonly deploymentIdSha256: string;
  } | null;
  readonly checks: Readonly<PermanentStagingAppDeploymentExecutorChecks>;
}

function emptyChecks(): PermanentStagingAppDeploymentExecutorChecks {
  return {
    policyExact: false,
    githubMainExact: false,
    sourceAuthorityExact: false,
    cliExact: false,
    writeTokenScopeExact: false,
    costPolicyExact: false,
    prerequisiteExact: false,
    workerFencePrerequisiteExact: false,
    workerFenceDeploymentContinuityExact: false,
    boundaryPreflightExact: false,
    targetPreflightExact: false,
    gitAutodeployAbsent: false,
    collateralInventoryExact: false,
    durableIntentExact: false,
    sourceReasserted: false,
    writeAttemptedAtMostOnce: true,
    targetPostflightAttempted: false,
    targetPostflightExact: false,
    reconciliationCompleted: false,
    topologyPreserved: false,
    deploymentExact: false,
    runtimeHealthExact: false,
    runtimeStartupExact: false,
    runtimeReadinessExact: false,
    collateralStateUnchanged: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
  };
}

function spawnCommand(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maximumOutputBytes: number;
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let forceTimer: NodeJS.Timeout | null = null;
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env ? { ...options.env } : undefined,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = (signal: NodeJS.Signals): void => {
      if (typeof child.pid === "number") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the direct child if the process group is already gone.
        }
      }
      try { child.kill(signal); } catch { /* process is already gone */ }
    };
    const collect = (
      current: string,
      currentBytes: number,
      chunk: Buffer,
    ): readonly [string, number] => {
      if (currentBytes + chunk.length > options.maximumOutputBytes) {
        overflow = true;
        return [current, currentBytes];
      }
      return [`${current}${chunk.toString("utf8")}`, currentBytes + chunk.length];
    };
    child.stdout.on("data", (chunk: Buffer) => {
      [stdout, stdoutBytes] = collect(stdout, stdoutBytes, chunk);
      if (overflow) killGroup("SIGTERM");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      [stderr, stderrBytes] = collect(stderr, stderrBytes, chunk);
      if (overflow) killGroup("SIGTERM");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      forceTimer = setTimeout(() => killGroup("SIGKILL"), 2_000);
      forceTimer.unref();
    }, options.timeoutMs);
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve(result);
    };
    child.on("error", () => finish({
      code: null,
      signal: null,
      timedOut,
      stdout,
      stderr,
    }));
    child.on("close", (code, signal) => finish({
      code: overflow ? null : code,
      signal,
      timedOut,
      stdout,
      stderr,
    }));
  });
}

async function checkedCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await spawnCommand(executable, args, {
    cwd,
    timeoutMs: 30_000,
    maximumOutputBytes: 2 * 1024 * 1024,
  });
  if (result.code !== 0 || result.timedOut) throw new Error("source_authority_failed");
  return result.stdout.trim();
}

type BigIntStats = fs.BigIntStats;

function requiredFilesystemFlag(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("filesystem_capability_unavailable");
  }
  return value;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function exactCanonicalPath(filename: string): boolean {
  return path.isAbsolute(filename)
    && path.normalize(filename) === filename
    && path.resolve(filename) === filename
    && !filename.includes("\0")
    && fs.realpathSync(filename) === filename;
}

function pathMatchesHeldDescriptor(
  filename: string,
  descriptor: number,
  expected: BigIntStats,
): boolean {
  const before = fs.lstatSync(filename, { bigint: true });
  const held = fs.fstatSync(descriptor, { bigint: true });
  if (
    before.isSymbolicLink()
    || !sameFileIdentity(before, expected)
    || !sameFileIdentity(held, expected)
    || !exactCanonicalPath(filename)
  ) return false;
  const after = fs.lstatSync(filename, { bigint: true });
  return !after.isSymbolicLink()
    && sameFileIdentity(before, after)
    && sameFileIdentity(after, held);
}

function sha256HeldDescriptor(
  descriptor: number,
  expectedSize: bigint,
  maximumBytes: number,
): string {
  if (
    expectedSize < 0n
    || expectedSize > BigInt(maximumBytes)
    || expectedSize > BigInt(Number.MAX_SAFE_INTEGER)
  ) throw new Error("held_file_invalid");
  const expectedBytes = Number(expectedSize);
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expectedBytes)));
  const hash = crypto.createHash("sha256");
  let offset = 0;
  try {
    while (offset < expectedBytes) {
      const requested = Math.min(buffer.length, expectedBytes - offset);
      const count = fs.readSync(descriptor, buffer, 0, requested, offset);
      if (count < 1) throw new Error("held_file_invalid");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    if (fs.readSync(descriptor, buffer, 0, 1, offset) !== 0) {
      throw new Error("held_file_invalid");
    }
    return hash.digest("hex");
  } finally {
    buffer.fill(0);
  }
}

function holdSnapshotRootDirectory(snapshotPath: string): HeldSnapshotRoot {
  let descriptor: number | null = null;
  try {
    if (process.platform !== "linux" || !exactCanonicalPath(snapshotPath)) {
      throw new Error("source_snapshot_invalid");
    }
    descriptor = fs.openSync(
      snapshotPath,
      fs.constants.O_RDONLY
        | requiredFilesystemFlag(fs.constants.O_DIRECTORY)
        | requiredFilesystemFlag(fs.constants.O_NOFOLLOW)
        | requiredFilesystemFlag(fs.constants.O_NONBLOCK),
    );
    const baseline = fs.fstatSync(descriptor, { bigint: true });
    const uid = process.geteuid?.() ?? process.getuid?.();
    if (
      !baseline.isDirectory()
      || !Number.isSafeInteger(uid)
      || baseline.uid !== BigInt(uid!)
      || (baseline.mode & 0o777n) !== 0o700n
      || !pathMatchesHeldDescriptor(snapshotPath, descriptor, baseline)
    ) throw new Error("source_snapshot_invalid");
    const heldDescriptor = descriptor;
    const authorityPath = `/proc/${process.pid}/fd/${heldDescriptor}`;
    if (!sameFileIdentity(
      baseline,
      fs.statSync(authorityPath, { bigint: true }),
    )) throw new Error("source_snapshot_invalid");
    let closed = false;
    const authority = Object.freeze({
      authorityPath,
      assertExact: (): void => {
        try {
          if (
            closed
            || !sameFileIdentity(
              baseline,
              fs.fstatSync(heldDescriptor, { bigint: true }),
            )
            || !pathMatchesHeldDescriptor(
              snapshotPath,
              heldDescriptor,
              baseline,
            )
            || !sameFileIdentity(
              baseline,
              fs.statSync(authorityPath, { bigint: true }),
            )
          ) throw new Error("source_snapshot_invalid");
        } catch {
          throw new Error("source_snapshot_invalid");
        }
      },
      close: (): void => {
        if (closed) return;
        fs.closeSync(heldDescriptor);
        closed = true;
      },
    });
    descriptor = null;
    return authority;
  } catch {
    throw new Error("source_snapshot_invalid");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function snapshotManifestSha256(
  snapshotRoot: string,
  rootAuthorityPath: string = snapshotRoot,
): string {
  try {
    const root = fs.realpathSync(snapshotRoot);
    if (!exactCanonicalPath(root)) throw new Error("source_snapshot_invalid");
    const noFollow = requiredFilesystemFlag(fs.constants.O_NOFOLLOW);
    const directoryOnly = requiredFilesystemFlag(fs.constants.O_DIRECTORY);
    const nonblocking = requiredFilesystemFlag(fs.constants.O_NONBLOCK);
    const readFlags = fs.constants.O_RDONLY | noFollow | nonblocking;
    const directoryFlags = readFlags | directoryOnly;
    const entries: Array<Readonly<{
      path: string;
      type: "directory" | "file";
      mode: number;
      size?: number;
      sha256?: string;
    }>> = [];
    const seenDirectories = new Set<string>();
    let totalBytes = 0n;

    const visitHeldDirectory = (
      directory: string,
      descriptor: number,
      held: BigIntStats,
    ): void => {
      const initial = fs.lstatSync(directory, { bigint: true });
      if (
        initial.isSymbolicLink()
        || !initial.isDirectory()
        || !sameFileIdentity(initial, held)
      ) throw new Error("source_snapshot_invalid");
      const identity = `${held.dev}:${held.ino}`;
      if (
        !held.isDirectory()
        || seenDirectories.has(identity)
        || !pathMatchesHeldDescriptor(directory, descriptor, held)
      ) throw new Error("source_snapshot_invalid");
      seenDirectories.add(identity);
      const heldPath = process.platform === "linux"
        ? `/proc/${process.pid}/fd/${descriptor}`
        : directory;
      const names = fs.readdirSync(heldPath).sort((left, right) =>
        Buffer.from(left).compare(Buffer.from(right)));
      for (const name of names) {
        if (/[\0\r\n]/.test(name)) throw new Error("source_snapshot_invalid");
        const absolute = path.join(directory, name);
        const heldChildPath = path.join(heldPath, name);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (
          entries.length >= 100_000
          || relative.startsWith("../")
          || path.isAbsolute(relative)
        ) throw new Error("source_snapshot_invalid");
        let childDescriptor: number | null = fs.openSync(heldChildPath, readFlags);
        try {
          const child = fs.fstatSync(childDescriptor, { bigint: true });
          const stat = fs.lstatSync(absolute, { bigint: true });
          if (
            stat.isSymbolicLink()
            || !sameFileIdentity(stat, child)
            || !pathMatchesHeldDescriptor(absolute, childDescriptor, child)
          ) throw new Error("source_snapshot_invalid");
          if (child.isDirectory()) {
            entries.push(Object.freeze({
              path: relative,
              type: "directory",
              mode: Number(child.mode & 0o777n),
            }));
            visitHeldDirectory(absolute, childDescriptor, child);
          } else if (child.isFile()) {
            if (child.nlink !== 1n) throw new Error("source_snapshot_invalid");
            totalBytes += child.size;
            if (totalBytes > 1024n * 1024n * 1024n) {
              throw new Error("source_snapshot_invalid");
            }
            const digest = sha256HeldDescriptor(
              childDescriptor,
              child.size,
              1024 * 1024 * 1024,
            );
            const after = fs.fstatSync(childDescriptor, { bigint: true });
            if (
              !sameFileIdentity(child, after)
              || !pathMatchesHeldDescriptor(absolute, childDescriptor, after)
            ) throw new Error("source_snapshot_invalid");
            entries.push(Object.freeze({
              path: relative,
              type: "file",
              mode: Number(child.mode & 0o777n),
              size: Number(child.size),
              sha256: digest,
            }));
          } else {
            throw new Error("source_snapshot_invalid");
          }
        } finally {
          if (childDescriptor !== null) {
            fs.closeSync(childDescriptor);
            childDescriptor = null;
          }
        }
      }
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (
        !sameFileIdentity(held, after)
        || !pathMatchesHeldDescriptor(directory, descriptor, after)
      ) throw new Error("source_snapshot_invalid");
    };
    let rootDescriptor: number | null = fs.openSync(
      snapshotRoot,
      directoryFlags,
    );
    try {
      const heldRoot = fs.fstatSync(rootDescriptor, { bigint: true });
      if (rootAuthorityPath !== snapshotRoot) {
        const authorityRoot = fs.statSync(rootAuthorityPath, { bigint: true });
        if (!sameFileIdentity(heldRoot, authorityRoot)) {
          throw new Error("source_snapshot_invalid");
        }
      }
      visitHeldDirectory(root, rootDescriptor, heldRoot);
    } finally {
      if (rootDescriptor !== null) {
        fs.closeSync(rootDescriptor);
        rootDescriptor = null;
      }
    }
    return sha256(canonicalJson(entries));
  } catch {
    throw new Error("source_snapshot_invalid");
  }
}

async function defaultCreateSourceAuthority(
  cwd: string,
  candidateSha: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<SourceAuthority> {
  if (
    env.GITHUB_ACTIONS !== "true"
    || env.GITHUB_REF !== "refs/heads/main"
    || env.GITHUB_SHA !== candidateSha
    || typeof env.RUNNER_TEMP !== "string"
    || !path.isAbsolute(env.RUNNER_TEMP)
  ) throw new Error("github_authority_failed");
  const head = await checkedCommand("git", ["rev-parse", "HEAD"], cwd);
  const main = await checkedCommand(
    "git",
    ["rev-parse", "refs/remotes/origin/main"],
    cwd,
  );
  const treeSha = await checkedCommand("git", ["rev-parse", "HEAD^{tree}"], cwd);
  const status = await checkedCommand(
    "git",
    ["status", "--porcelain=v2", "--untracked-files=all"],
    cwd,
  );
  if (
    head !== candidateSha
    || main !== candidateSha
    || status !== ""
    || !SHA1_PATTERN.test(treeSha)
    || sha256(fs.readFileSync(path.join(cwd, "railway.toml")))
      !== RAILWAY_CONFIG_SHA256
    || sha256(fs.readFileSync(path.join(cwd, "package-lock.json")))
      !== PACKAGE_LOCK_SHA256
  ) throw new Error("source_authority_failed");

  const privateRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(env.RUNNER_TEMP), "pintpath-app-deploy-"),
  );
  fs.chmodSync(privateRoot, 0o700);
  const archivePath = path.join(privateRoot, "candidate.tar");
  const snapshotPath = path.join(privateRoot, "snapshot");
  fs.mkdirSync(snapshotPath, { mode: 0o700 });
  let heldSnapshotRoot: HeldSnapshotRoot | null = null;
  try {
    await checkedCommand(
      "git",
      ["archive", "--format=tar", `--output=${archivePath}`, candidateSha],
      cwd,
    );
    fs.chmodSync(archivePath, 0o600);
    await checkedCommand("tar", ["-xf", archivePath, "-C", snapshotPath], cwd);
    const archiveSha256 = sha256(fs.readFileSync(archivePath));
    const manifestSha256 = snapshotManifestSha256(snapshotPath);
    heldSnapshotRoot = holdSnapshotRootDirectory(snapshotPath);
    const snapshotRoot = heldSnapshotRoot;
    const reassert = () => {
      try {
        snapshotRoot.assertExact();
        const root = fs.lstatSync(privateRoot);
        const archive = fs.lstatSync(archivePath);
        const snapshot = fs.lstatSync(snapshotPath);
        if (
          !root.isDirectory()
          || root.isSymbolicLink()
          || (root.mode & 0o777) !== 0o700
          || !archive.isFile()
          || archive.isSymbolicLink()
          || archive.nlink !== 1
          || (archive.mode & 0o777) !== 0o600
          || !snapshot.isDirectory()
          || snapshot.isSymbolicLink()
          || (snapshot.mode & 0o777) !== 0o700
          || sha256(fs.readFileSync(archivePath)) !== archiveSha256
          || snapshotManifestSha256(
            snapshotPath,
            snapshotRoot.authorityPath,
          ) !== manifestSha256
        ) throw new Error("source_reassertion_failed");
      } catch {
        throw new Error("source_reassertion_failed");
      }
    };
    reassert();
    return Object.freeze({
      candidateSha,
      treeSha,
      archiveSha256,
      snapshotManifestSha256: manifestSha256,
      snapshotPath,
      deploymentPath: snapshotRoot.authorityPath,
      close: snapshotRoot.close,
      reassert,
      cleanup: () => {
        try {
          snapshotRoot.close();
        } finally {
          fs.rmSync(privateRoot, { recursive: true, force: false });
        }
      },
    });
  } catch (error) {
    try { heldSnapshotRoot?.close(); } catch { /* Cleanup continues below. */ }
    fs.rmSync(privateRoot, { recursive: true, force: true });
    throw error;
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new Error("provider_query_failed");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_PROVIDER_BYTES)) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("provider_query_failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_PROVIDER_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("provider_query_failed");
    }
    chunks.push(next.value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

async function railwayQuery(
  fetchImpl: typeof fetch,
  token: string,
  operationName: string,
  query: string,
  variables: Readonly<Record<string, string | null>>,
): Promise<string> {
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Project-Access-Token": token,
    },
    body: JSON.stringify({ operationName, query, variables }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  return readBoundedResponse(response);
}

function parseDiscoveryDeploymentId(source: string): string | null {
  try {
    const value: unknown = JSON.parse(source);
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.keys(value).join(",") !== "data"
    ) return null;
    const data = (value as Record<string, unknown>).data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const instance = (data as Record<string, unknown>).serviceInstance;
    if (typeof instance !== "object" || instance === null || Array.isArray(instance)) {
      return null;
    }
    const latest = (instance as Record<string, unknown>).latestDeployment;
    if (typeof latest !== "object" || latest === null || Array.isArray(latest)) return null;
    const id = (latest as Record<string, unknown>).id;
    return typeof id === "string" && UUID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key, index) => Object.keys(value)[index] !== key)
  ) return null;
  return value as Record<string, unknown>;
}

function safeProviderString(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= maximumBytes
    && !/[\r\n\0]/.test(value);
}

function parseCompleteConnection(value: unknown): readonly unknown[] | null {
  const connection = exactRecord(value, ["edges", "pageInfo"]);
  if (!connection || !Array.isArray(connection.edges) || connection.edges.length > 2_000) {
    return null;
  }
  const pageInfo = exactRecord(connection.pageInfo, ["hasNextPage", "endCursor"]);
  if (
    !pageInfo
    || pageInfo.hasNextPage !== false
    || !(pageInfo.endCursor === null
      || safeProviderString(pageInfo.endCursor, 512))
  ) return null;
  return connection.edges;
}

interface CollateralConnectionPage {
  readonly edges: readonly unknown[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

function parseCollateralConnectionPage(value: unknown): CollateralConnectionPage | null {
  const connection = exactRecord(value, ["edges", "pageInfo"]);
  if (!connection || !Array.isArray(connection.edges) || connection.edges.length > 100) {
    return null;
  }
  const pageInfo = exactRecord(connection.pageInfo, ["hasNextPage", "endCursor"]);
  if (
    !pageInfo
    || typeof pageInfo.hasNextPage !== "boolean"
    || !(pageInfo.endCursor === null
      || safeProviderString(pageInfo.endCursor, 512))
    || (pageInfo.hasNextPage && pageInfo.endCursor === null)
  ) return null;
  return {
    edges: connection.edges,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor as string | null,
  };
}

async function queryCollateralSnapshot(
  fetchImpl: typeof fetch,
  token: string,
  projectId: string,
  environmentId: string,
): Promise<string> {
  const connectionNames = [
    "variables",
    "volumeInstances",
    "serviceInstances",
  ] as const;
  const cursors: Record<typeof connectionNames[number], string | null> = {
    variables: null,
    volumeInstances: null,
    serviceInstances: null,
  };
  const completed: Record<typeof connectionNames[number], boolean> = {
    variables: false,
    volumeInstances: false,
    serviceInstances: false,
  };
  const edges: Record<typeof connectionNames[number], unknown[]> = {
    variables: [],
    volumeInstances: [],
    serviceInstances: [],
  };
  const seenCursors: Record<typeof connectionNames[number], Set<string>> = {
    variables: new Set(),
    volumeInstances: new Set(),
    serviceInstances: new Set(),
  };

  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const source = await railwayQuery(
      fetchImpl,
      token,
      "PintPathRailwayApplicationDeploymentCollateral",
      RAILWAY_APPLICATION_DEPLOYMENT_COLLATERAL_QUERY,
      {
        projectId,
        environmentId,
        variablesAfter: cursors.variables,
        volumeInstancesAfter: cursors.volumeInstances,
        serviceInstancesAfter: cursors.serviceInstances,
      },
    );
    let root: Record<string, unknown> | null = null;
    let environment: Record<string, unknown> | null = null;
    try {
      root = exactRecord(JSON.parse(source), ["data"]);
      const data = exactRecord(root?.data, ["environment"]);
      environment = exactRecord(data?.environment, [
        "id",
        "variables",
        "volumeInstances",
        "serviceInstances",
      ]);
    } catch {
      throw new Error("provider_query_failed");
    }
    if (!environment || environment.id !== environmentId) {
      throw new Error("provider_query_failed");
    }
    for (const name of connectionNames) {
      const page = parseCollateralConnectionPage(environment[name]);
      if (!page) throw new Error("provider_query_failed");
      if (completed[name]) continue;
      if (edges[name].length + page.edges.length > 2_000) {
        throw new Error("provider_query_failed");
      }
      edges[name].push(...page.edges);
      if (!page.hasNextPage) {
        completed[name] = true;
        continue;
      }
      if (
        page.endCursor === null
        || seenCursors[name].has(page.endCursor)
      ) throw new Error("provider_query_failed");
      seenCursors[name].add(page.endCursor);
      cursors[name] = page.endCursor;
    }
    if (connectionNames.every((name) => completed[name])) {
      return JSON.stringify({
        data: {
          environment: {
            id: environmentId,
            variables: { edges: edges.variables, pageInfo: { hasNextPage: false, endCursor: null } },
            volumeInstances: { edges: edges.volumeInstances, pageInfo: { hasNextPage: false, endCursor: null } },
            serviceInstances: { edges: edges.serviceInstances, pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      });
    }
  }
  throw new Error("provider_query_failed");
}

function parseCollateralSnapshot(
  source: string,
  environmentId: string,
  targetServiceId: string,
): { collateralSha256: string; gitAutodeployAbsent: boolean } | null {
  try {
    const root = exactRecord(JSON.parse(source), ["data"]);
    const data = exactRecord(root?.data, ["environment"]);
    const environment = exactRecord(data?.environment, [
      "id",
      "variables",
      "volumeInstances",
      "serviceInstances",
    ]);
    if (!environment || environment.id !== environmentId) return null;
    const variableEdges = parseCompleteConnection(environment.variables);
    const volumeEdges = parseCompleteConnection(environment.volumeInstances);
    const serviceEdges = parseCompleteConnection(environment.serviceInstances);
    if (!variableEdges || !volumeEdges || !serviceEdges) return null;

    const variables = variableEdges.map((edge) => {
      const row = exactRecord(edge, ["node"]);
      const node = exactRecord(row?.node, [
        "id",
        "name",
        "environmentId",
        "serviceId",
        "isSealed",
        "references",
      ]);
      if (
        !node
        || typeof node.id !== "string"
        || node.id.length < 1
        || !safeProviderString(node.id, 256)
        || !safeProviderString(node.name, 256)
        || !/^[A-Z][A-Z0-9_]{0,255}$/.test(node.name)
        || node.environmentId !== environmentId
        || !(node.serviceId === null
          || (typeof node.serviceId === "string" && UUID_PATTERN.test(node.serviceId)))
        || typeof node.isSealed !== "boolean"
        || !Array.isArray(node.references)
        || node.references.length > 100
        || node.references.some((reference) => !safeProviderString(reference, 512))
      ) throw new Error("collateral_invalid");
      return {
        id: node.id,
        name: node.name,
        environmentId: node.environmentId,
        serviceId: node.serviceId,
        isSealed: node.isSealed,
        references: [...node.references].sort(),
      };
    }).sort((left, right) => left.id.localeCompare(right.id));

    const volumes = volumeEdges.map((edge) => {
      const row = exactRecord(edge, ["node"]);
      const node = exactRecord(row?.node, [
        "serviceId",
        "environmentId",
        "volume",
      ]);
      const volume = exactRecord(node?.volume, ["id"]);
      if (
        !node
        || !(node.serviceId === null
          || (typeof node.serviceId === "string" && UUID_PATTERN.test(node.serviceId)))
        || node.environmentId !== environmentId
        || !volume
        || typeof volume.id !== "string"
        || !UUID_PATTERN.test(volume.id)
      ) throw new Error("collateral_invalid");
      return {
        serviceId: node.serviceId,
        environmentId: node.environmentId,
        volumeId: volume.id,
      };
    }).sort((left, right) => left.volumeId.localeCompare(right.volumeId));

    const services = serviceEdges.map((edge) => {
      const row = exactRecord(edge, ["node"]);
      const node = exactRecord(row?.node, [
        "id",
        "serviceId",
        "serviceName",
        "environmentId",
        "numReplicas",
        "source",
        "domains",
        "cronSchedule",
        "startCommand",
      ]);
      const sourceValue = node?.source === null
        ? null
        : exactRecord(node?.source, ["repo", "image"]);
      const domains = exactRecord(node?.domains, ["serviceDomains", "customDomains"]);
      if (
        !node
        || typeof node.id !== "string"
        || !UUID_PATTERN.test(node.id)
        || typeof node.serviceId !== "string"
        || !UUID_PATTERN.test(node.serviceId)
        || !safeProviderString(node.serviceName, 256)
        || node.environmentId !== environmentId
        || !(node.numReplicas === null
          || (Number.isSafeInteger(node.numReplicas)
            && (node.numReplicas as number) >= 0
            && (node.numReplicas as number) <= 50))
        || (node.source !== null && !sourceValue)
        || !domains
        || !Array.isArray(domains.serviceDomains)
        || !Array.isArray(domains.customDomains)
        || domains.serviceDomains.length > 100
        || domains.customDomains.length > 100
        || !(node.cronSchedule === null
          || safeProviderString(node.cronSchedule, 512))
        || !(node.startCommand === null
          || safeProviderString(node.startCommand, 4_096))
      ) throw new Error("collateral_invalid");
      if (sourceValue && (
        !(sourceValue.repo === null || safeProviderString(sourceValue.repo, 512))
        || !(sourceValue.image === null || safeProviderString(sourceValue.image, 512))
      )) throw new Error("collateral_invalid");
      const normalizedDomains = [
        ...(domains.serviceDomains as unknown[]).map((domain) => ({ kind: "service", domain })),
        ...(domains.customDomains as unknown[]).map((domain) => ({ kind: "custom", domain })),
      ].map(({ kind, domain }) => {
        const value = exactRecord(domain, ["id", "domain", "targetPort"]);
        if (
          !value
          || typeof value.id !== "string"
          || !UUID_PATTERN.test(value.id)
          || !safeProviderString(value.domain, 253)
          || !(value.targetPort === null
            || (Number.isSafeInteger(value.targetPort)
              && (value.targetPort as number) >= 1
              && (value.targetPort as number) <= 65_535))
        ) throw new Error("collateral_invalid");
        return {
          kind,
          id: value.id as string,
          domain: value.domain as string,
          targetPort: value.targetPort as number | null,
        };
      }).sort((left, right) => String(left.id).localeCompare(String(right.id)));
      return {
        id: node.id,
        serviceId: node.serviceId,
        serviceName: node.serviceName,
        environmentId: node.environmentId,
        numReplicas: node.numReplicas,
        source: sourceValue,
        domains: normalizedDomains,
        cronSchedule: node.cronSchedule,
        startCommand: node.startCommand,
      };
    }).sort((left, right) => left.id.localeCompare(right.id));
    if (
      new Set(variables.map((variable) => variable.id)).size !== variables.length
      || new Set(volumes.map((volume) => volume.volumeId)).size !== volumes.length
      || new Set(services.map((service) => service.id)).size !== services.length
    ) return null;
    const targets = services.filter((service) => service.serviceId === targetServiceId);
    if (targets.length !== 1) return null;
    return {
      collateralSha256: sha256(canonicalJson({ variables, volumes, services })),
      gitAutodeployAbsent: targets[0]!.source?.repo == null,
    };
  } catch {
    return null;
  }
}

function originHostname(origin: string): string {
  return new URL(origin).hostname;
}

function validatedProviderObservation(
  policy: PermanentStagingAppDeploymentPolicy,
  environmentId: string,
  expectedReplicaCounts: readonly number[],
  publicOrigin: string,
  scope: { readonly projectId: string; readonly environmentId: string },
  patch: { readonly environmentId: string; readonly patchEmpty: true },
  snapshot: RailwayApplicationDeploymentAttestationProviderSnapshot | null,
  collateral: ReturnType<typeof parseCollateralSnapshot>,
): ProviderObservation {
  if (!snapshot || !collateral) throw new Error("provider_query_failed");
  const hostname = originHostname(publicOrigin);
  const exact = scope.projectId === policy.projectId
    && scope.environmentId === environmentId
    && patch.environmentId === environmentId
    && snapshot.environmentId === environmentId
    && snapshot.serviceId === policy.target.serviceId
    && snapshot.deployment.projectId === policy.projectId
    && snapshot.deployment.environmentId === environmentId
    && snapshot.deployment.serviceId === policy.target.serviceId
    && expectedReplicaCounts.includes(snapshot.numReplicas)
    && snapshot.domains.some((domain) => domain.domain === hostname);
  if (!exact) throw new Error("provider_target_mismatch");
  return {
    tokenScopeExact: true,
    patchEmpty: patch.patchEmpty === true,
    gitAutodeployAbsent: collateral.gitAutodeployAbsent,
    collateralSha256: collateral.collateralSha256,
    snapshot,
  };
}

async function defaultQueryTarget(
  fetchImpl: typeof fetch,
  policy: PermanentStagingAppDeploymentPolicy,
  environmentId: string,
  expectedReplicaCounts: readonly number[],
  publicOrigin: string,
  token: string,
): Promise<ProviderObservation> {
  if (
    expectedReplicaCounts.length < 1
    || expectedReplicaCounts.length > policy.target.allowedReplicaCounts.length
    || new Set(expectedReplicaCounts).size !== expectedReplicaCounts.length
    || expectedReplicaCounts.some((count) =>
      !(policy.target.allowedReplicaCounts as readonly number[]).includes(count))
  ) throw new Error("provider_target_mismatch");
  const [tokenSource, patchSource, discoverySource] = await Promise.all([
    railwayQuery(
      fetchImpl,
      token,
      "PintPathRailwayApplicationDeploymentTokenScope",
      RAILWAY_APPLICATION_DEPLOYMENT_TOKEN_SCOPE_QUERY,
      {},
    ),
    railwayQuery(
      fetchImpl,
      token,
      "PintPathRailwayApplicationDeploymentEmptyPatch",
      RAILWAY_APPLICATION_DEPLOYMENT_EMPTY_PATCH_QUERY,
      { projectId: policy.projectId, environmentId },
    ),
    railwayQuery(
      fetchImpl,
      token,
      "PintPathRailwayApplicationDeploymentDiscovery",
      RAILWAY_APPLICATION_DEPLOYMENT_DISCOVERY_QUERY,
      { environmentId, serviceId: policy.target.serviceId },
    ),
  ]);
  const scope = parseRailwayApplicationDeploymentAttestationTokenScopeResponse(
    tokenSource,
  );
  const patch = parseRailwayApplicationDeploymentAttestationEmptyPatchResponse(
    patchSource,
  );
  const deploymentId = parseDiscoveryDeploymentId(discoverySource);
  if (!scope || !patch || !deploymentId) throw new Error("provider_query_failed");
  const [snapshotSource, collateralSource] = await Promise.all([
    railwayQuery(
      fetchImpl,
      token,
      "PintPathRailwayApplicationDeploymentSnapshot",
      RAILWAY_APPLICATION_DEPLOYMENT_SNAPSHOT_QUERY,
      { environmentId, serviceId: policy.target.serviceId, deploymentId },
    ),
    queryCollateralSnapshot(
      fetchImpl,
      token,
      policy.projectId,
      environmentId,
    ),
  ]);
  const snapshot =
    parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse(
      snapshotSource,
    );
  const collateral = parseCollateralSnapshot(
    collateralSource,
    environmentId,
    policy.target.serviceId,
  );
  return validatedProviderObservation(
    policy,
    environmentId,
    expectedReplicaCounts,
    publicOrigin,
    scope,
    patch,
    snapshot,
    collateral,
  );
}

async function defaultValidateWriteToken(
  fetchImpl: typeof fetch,
  policy: PermanentStagingAppDeploymentPolicy,
  token: string,
): Promise<boolean> {
  const source = await railwayQuery(
    fetchImpl,
    token,
    "PintPathRailwayApplicationDeploymentTokenScope",
    RAILWAY_APPLICATION_DEPLOYMENT_TOKEN_SCOPE_QUERY,
    {},
  );
  const scope = parseRailwayApplicationDeploymentAttestationTokenScopeResponse(
    source,
  );
  return scope?.projectId === policy.projectId
    && scope.environmentId === policy.target.environmentId;
}

function tokenForTarget(
  target: DeploymentTarget,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const name = target === "production"
    ? "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN"
    : "PINTPATH_RAILWAY_STAGING_METADATA_TOKEN";
  const token = env[name];
  if (typeof token !== "string" || !SAFE_TOKEN_PATTERN.test(token)) {
    throw new Error("metadata_token_missing");
  }
  return token;
}

function runtimeMatches(
  route: typeof RUNTIME_ROUTES[number],
  response: RailwayApplicationDeploymentAttestationRuntimeResponse,
  candidateSha: string,
  policy: PermanentStagingAppDeploymentPolicy,
  environmentId: string,
  deploymentId: string,
): boolean {
  return response.route === route
    && response.deployment.commitSha === candidateSha
    && response.deployment.projectIdSha256
      === railwayDeploymentIdentityIdSha256("project", policy.projectId)
    && response.deployment.environmentIdSha256
      === railwayDeploymentIdentityIdSha256("environment", environmentId)
    && response.deployment.serviceIdSha256
      === railwayDeploymentIdentityIdSha256("service", policy.target.serviceId)
    && response.deployment.deploymentIdSha256
      === railwayDeploymentIdentityIdSha256("deployment", deploymentId)
    && response.automaticMaintenance.enabled
      === policy.postflightContract.automaticMaintenanceEnabled
    && response.automaticMaintenance.candidateBound
      === policy.postflightContract.automaticMaintenanceCandidateBindingRequired
    && response.restoreMarkerPresent === false;
}

async function defaultProbeRuntime(
  fetchImpl: typeof fetch,
  origin: string,
  candidateSha: string,
  policy: PermanentStagingAppDeploymentPolicy,
  environmentId: string,
  deploymentId: string,
): Promise<RuntimeObservation> {
  const parsed: RailwayApplicationDeploymentAttestationRuntimeResponse[] = [];
  for (const route of RUNTIME_ROUTES) {
    const response = await fetchImpl(`${origin}${route}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const source = await readBoundedResponse(response);
    const runtime = parseRailwayApplicationDeploymentAttestationRuntimeResponse(
      route,
      source,
    );
    if (!runtime || !runtimeMatches(
      route,
      runtime,
      candidateSha,
      policy,
      environmentId,
      deploymentId,
    )) throw new Error("runtime_probe_failed");
    parsed.push(runtime);
  }
  return {
    health: parsed[0]!,
    startup: parsed[1]!,
    ready: parsed[2]!,
  };
}

async function defaultRunBoundary(
  policy: PermanentStagingAppDeploymentPolicy,
  env: Readonly<Record<string, string | undefined>>,
): Promise<BoundaryObservation> {
  let source = "";
  const code = await runRailwayMutationBoundaryCheck({
    argv: ["--policy", path.resolve(policy.mutationBoundary.policyPath)],
    env: {
      PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN:
        env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN,
      PINTPATH_RAILWAY_STAGING_METADATA_TOKEN:
        env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN,
    },
    writeOutput: (value) => { source += value; },
  });
  let passed = false;
  try {
    const receipt = JSON.parse(source) as Record<string, unknown>;
    passed = code === 0
      && receipt.mode === "read-only-boundary"
      && receipt.outcome === "passed";
  } catch {
    passed = false;
  }
  return { ok: passed, source };
}

const DEFAULT_DEPENDENCIES: ExecutorDependencies = {
  cwd: process.cwd(),
  env: process.env,
  platform: process.platform,
  arch: process.arch,
  now: () => new Date(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  fetchImpl: fetch,
  runCommand: spawnCommand,
  createSourceAuthority: defaultCreateSourceAuthority,
  validateCli,
  validateWriteToken: async (...args) => defaultValidateWriteToken(fetch, ...args),
  validateProductionWorkerFencePrerequisite:
    parseProductionDeploymentWorkerFencePrerequisiteVerification,
  queryTarget: async (...args) => defaultQueryTarget(fetch, ...args),
  probeRuntime: async (...args) => defaultProbeRuntime(fetch, ...args),
  runBoundary: defaultRunBoundary,
  writeOutput: (value) => process.stdout.write(value),
};

function parseArguments(argv: readonly string[]): {
  policyPath: string;
  candidateSha: string;
  evidenceDir: string;
  productionWorkerFenceRunId: string | null;
  productionWorkerFenceVerificationFile: string | null;
} {
  const allowed = new Set([
    "--policy",
    "--candidate-sha",
    "--evidence-dir",
    "--production-worker-fence-run-id",
    "--production-worker-fence-verification-file",
  ]);
  const values = new Map<string, string>();
  if (argv.length % 2 !== 0) throw new Error("argument_invalid");
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name || !value || !allowed.has(name) || values.has(name)) {
      throw new Error("argument_invalid");
    }
    values.set(name, value);
  }
  const policyPath = values.get("--policy");
  const candidateSha = values.get("--candidate-sha");
  const evidenceDir = values.get("--evidence-dir");
  if (
    !policyPath
    || !candidateSha
    || !SHA1_PATTERN.test(candidateSha)
    || !evidenceDir
    || !path.isAbsolute(evidenceDir)
  ) throw new Error("argument_invalid");
  return {
    policyPath,
    candidateSha,
    evidenceDir,
    productionWorkerFenceRunId:
      values.get("--production-worker-fence-run-id") ?? null,
    productionWorkerFenceVerificationFile:
      values.get("--production-worker-fence-verification-file") ?? null,
  };
}

function readPrivatePrerequisite(
  filename: string,
  evidenceDir: string,
): string {
  let bytes: Buffer | null = null;
  try {
    if (
      !path.isAbsolute(filename)
      || path.basename(filename)
        !== "production-deployment-worker-fence-verification.json"
      || path.dirname(path.resolve(filename)) !== fs.realpathSync(evidenceDir)
    ) throw new Error("worker_fence_prerequisite_failed");
    bytes = readTrustedRegularFile(filename, {
      minBytes: 2,
      maxBytes: 1024 * 1024,
      requireExactMode: 0o600,
      requireOwner: true,
      requirePrivate: true,
    });
    const source = bytes.toString("utf8");
    if (source.includes("\0")) throw new Error("worker_fence_prerequisite_failed");
    return source;
  } catch {
    throw new Error("worker_fence_prerequisite_failed");
  } finally {
    bytes?.fill(0);
  }
}

function assertEvidenceDirectory(evidenceDir: string): void {
  const stat = fs.lstatSync(evidenceDir);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (typeof process.geteuid === "function" && stat.uid !== process.geteuid())
    || (stat.mode & 0o777) !== 0o700
    || fs.realpathSync(evidenceDir) !== path.resolve(evidenceDir)
  ) throw new Error("evidence_directory_unsafe");
}

function writeEvidence(
  evidenceDir: string,
  leaf: string,
  source: string,
): string {
  if (!/^[a-z0-9-]+\.json$/.test(leaf)) throw new Error("evidence_leaf_invalid");
  const destination = path.join(evidenceDir, leaf);
  if (fs.existsSync(destination)) throw new Error("evidence_exists");
  const temporary = path.join(evidenceDir, `.${leaf}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, source, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const fd = fs.openSync(temporary, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(temporary, destination);
    fs.unlinkSync(temporary);
    const directoryFd = fs.openSync(evidenceDir, "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return sha256(source);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* no temporary file remains */ }
    throw error;
  }
}

function deploymentHealthy(
  observation: ProviderObservation,
  policy: PermanentStagingAppDeploymentPolicy,
  candidateSha: string,
  expectedReplicaCount: number,
): boolean {
  const snapshot = observation.snapshot;
  return observation.tokenScopeExact
    && observation.patchEmpty
    && observation.gitAutodeployAbsent
    && SHA256_PATTERN.test(observation.collateralSha256)
    && (policy.target.allowedReplicaCounts as readonly number[])
      .includes(expectedReplicaCount)
    && snapshot.numReplicas === expectedReplicaCount
    && snapshot.latestDeployment.id === snapshot.deployment.id
    && snapshot.latestDeployment.status === "SUCCESS"
    && snapshot.latestDeployment.deploymentStopped === false
    && snapshot.activeDeployments.length === 1
    && snapshot.activeDeployments[0]?.id === snapshot.deployment.id
    && snapshot.activeDeployments[0]?.status === "SUCCESS"
    && snapshot.activeDeployments[0]?.deploymentStopped === false
    && snapshot.deployment.commitHash === candidateSha
    && snapshot.deployment.patchId === null;
}

function collateralUnchanged(
  before: ProviderObservation,
  after: ProviderObservation,
): boolean {
  const domains = (observation: ProviderObservation) =>
    [...observation.snapshot.domains]
      .map((domain) => ({ ...domain }))
      .sort((left, right) =>
        `${left.kind}\0${left.id}\0${left.domain}\0${left.targetPort ?? ""}`
          .localeCompare(
            `${right.kind}\0${right.id}\0${right.domain}\0${right.targetPort ?? ""}`,
          ));
  return before.snapshot.serviceInstanceId === after.snapshot.serviceInstanceId
    && before.snapshot.serviceId === after.snapshot.serviceId
    && before.snapshot.environmentId === after.snapshot.environmentId
    && before.snapshot.numReplicas === after.snapshot.numReplicas
    && canonicalJson(domains(before)) === canonicalJson(domains(after))
    && before.collateralSha256 === after.collateralSha256;
}

function providerDeploymentUnchanged(
  before: ProviderObservation,
  after: ProviderObservation,
): boolean {
  const active = (observation: ProviderObservation) =>
    [...observation.snapshot.activeDeployments]
      .map((deployment) => ({ ...deployment }))
      .sort((left, right) => left.id.localeCompare(right.id));
  return before.snapshot.latestDeployment.id === after.snapshot.latestDeployment.id
    && before.snapshot.latestDeployment.status
      === after.snapshot.latestDeployment.status
    && before.snapshot.latestDeployment.deploymentStopped
      === after.snapshot.latestDeployment.deploymentStopped
    && before.snapshot.latestDeployment.snapshotId
      === after.snapshot.latestDeployment.snapshotId
    && canonicalJson(active(before)) === canonicalJson(active(after))
    && canonicalJson(before.snapshot.deployment)
      === canonicalJson(after.snapshot.deployment);
}

function currentEffectiveUid(): bigint {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (!Number.isSafeInteger(uid)) throw new Error("cli_invalid");
  return BigInt(uid!);
}

function heldRegularFileExact(
  filename: string,
  descriptor: number,
  baseline: BigIntStats,
  expectedUid: bigint,
  expectedMode: bigint,
  expectedSha256: string,
  maximumBytes: number,
): boolean {
  const held = fs.fstatSync(descriptor, { bigint: true });
  if (
    !held.isFile()
    || held.nlink !== 1n
    || held.uid !== expectedUid
    || (held.mode & 0o777n) !== expectedMode
    || held.size < 1n
    || held.size > BigInt(maximumBytes)
    || !sameFileIdentity(baseline, held)
    || !pathMatchesHeldDescriptor(filename, descriptor, held)
  ) return false;
  const digest = sha256HeldDescriptor(descriptor, held.size, maximumBytes);
  const after = fs.fstatSync(descriptor, { bigint: true });
  return digest === expectedSha256
    && sameFileIdentity(held, after)
    && pathMatchesHeldDescriptor(filename, descriptor, after);
}

function openPinnedRegularFile(
  filename: string,
  expectedUid: bigint,
  expectedMode: bigint,
  expectedSha256: string,
  maximumBytes: number,
): { readonly descriptor: number; readonly baseline: BigIntStats } {
  let descriptor: number | null = null;
  try {
    if (!exactCanonicalPath(filename) || !SHA256_PATTERN.test(expectedSha256)) {
      throw new Error("cli_invalid");
    }
    descriptor = fs.openSync(
      filename,
      fs.constants.O_RDONLY
        | requiredFilesystemFlag(fs.constants.O_NOFOLLOW)
        | requiredFilesystemFlag(fs.constants.O_NONBLOCK),
    );
    const baseline = fs.fstatSync(descriptor, { bigint: true });
    if (!heldRegularFileExact(
      filename,
      descriptor,
      baseline,
      expectedUid,
      expectedMode,
      expectedSha256,
      maximumBytes,
    )) throw new Error("cli_invalid");
    const result = { descriptor, baseline };
    descriptor = null;
    return result;
  } catch {
    throw new Error("cli_invalid");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

async function validateCli(
  policy: PermanentStagingAppDeploymentPolicy,
  dependencies: ExecutorDependencies,
): Promise<CliAuthority> {
  const cliPath = dependencies.env.PINTPATH_RAILWAY_CLI_PATH;
  const archivePath = dependencies.env.PINTPATH_RAILWAY_CLI_ARCHIVE;
  let authority: CliAuthority | null = null;
  let archiveDescriptor: number | null = null;
  let cliDescriptor: number | null = null;
  try {
    if (
      process.platform !== "linux"
      || dependencies.platform !== policy.railwayCli.platform
      || dependencies.platform !== "linux"
      || dependencies.arch !== policy.railwayCli.architecture
      || typeof cliPath !== "string"
      || typeof archivePath !== "string"
    ) throw new Error("cli_invalid");
    const uid = currentEffectiveUid();
    const archive = openPinnedRegularFile(
      archivePath,
      uid,
      0o400n,
      policy.railwayCli.archiveSha256,
      256 * 1024 * 1024,
    );
    archiveDescriptor = archive.descriptor;
    fs.closeSync(archiveDescriptor);
    archiveDescriptor = null;

    const executable = openPinnedRegularFile(
      cliPath,
      uid,
      0o500n,
      policy.railwayCli.executableSha256,
      128 * 1024 * 1024,
    );
    cliDescriptor = executable.descriptor;
    const descriptor = cliDescriptor;
    const procPath = `/proc/${process.pid}/fd/${descriptor}`;
    const procStat = fs.statSync(procPath, { bigint: true });
    if (!sameFileIdentity(executable.baseline, procStat)) {
      throw new Error("cli_invalid");
    }
    let closed = false;
    authority = Object.freeze({
      executablePath: procPath,
      assertExact: (): void => {
        try {
          if (
            closed
            || !heldRegularFileExact(
              cliPath,
              descriptor,
              executable.baseline,
              uid,
              0o500n,
              policy.railwayCli.executableSha256,
              128 * 1024 * 1024,
            )
            || !sameFileIdentity(
              executable.baseline,
              fs.statSync(procPath, { bigint: true }),
            )
          ) throw new Error("cli_invalid");
        } catch {
          throw new Error("cli_invalid");
        }
      },
      close: (): void => {
        if (closed) return;
        fs.closeSync(descriptor);
        closed = true;
      },
    });
    authority.assertExact();
    const result = await dependencies.runCommand(procPath, ["--version"], {
      timeoutMs: 5_000,
      maximumOutputBytes: 1024,
      env: { CI: "true", NO_COLOR: "1" },
    });
    authority.assertExact();
    if (
      result.code !== 0
      || result.timedOut
      || result.stdout.trim() !== `railway ${policy.railwayCli.version}`
    ) throw new Error("cli_invalid");
    cliDescriptor = null;
    return authority;
  } catch {
    if (authority !== null) {
      try {
        authority.close();
        cliDescriptor = null;
      } catch { /* The finally block retries the raw descriptor close. */ }
    }
    throw new Error("cli_invalid");
  } finally {
    if (archiveDescriptor !== null) fs.closeSync(archiveDescriptor);
    if (cliDescriptor !== null) fs.closeSync(cliDescriptor);
  }
}

function costPolicyExact(
  policy: PermanentStagingAppDeploymentPolicy,
  cwd: string,
): boolean {
  if (!policy.costContract.required) return true;
  if (
    !policy.costContract.policyPath
    || !policy.costContract.policySha256
    || !policy.costContract.policySchema
    || !policy.costContract.policyId
  ) return false;
  try {
    const source = fs.readFileSync(
      path.resolve(cwd, policy.costContract.policyPath),
      "utf8",
    );
    const parsed: unknown = JSON.parse(source);
    return sha256(source) === policy.costContract.policySha256
      && typeof parsed === "object"
      && parsed !== null
      && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).schemaVersion
        === policy.costContract.policySchema
      && (parsed as Record<string, unknown>).policyId
        === policy.costContract.policyId
      && (parsed as Record<string, unknown>).activationState
        === "ACTIVE_READ_ONLY_EXTERNAL_OBSERVATION_BINDER"
      && policy.costContract.deploymentMayClaimCostGatePassed === false
      && policy.costContract.singleCombinedReceiptRequiredForRelease
      && policy.costContract.receiptMayAuthorizeDeployment === false;
  } catch {
    return false;
  }
}

async function pollForCandidate(
  policy: PermanentStagingAppDeploymentPolicy,
  token: string,
  candidateSha: string,
  preservedReplicaCount: number,
  dependencies: ExecutorDependencies,
): Promise<ProviderObservation | null> {
  const deadline = dependencies.now().getTime()
    + policy.postflightContract.maximumObservationSeconds * 1000;
  do {
    try {
      const observation = await dependencies.queryTarget(
        policy,
        policy.target.environmentId,
        [preservedReplicaCount],
        policy.target.publicOrigin,
        token,
      );
      if (deploymentHealthy(
        observation,
        policy,
        candidateSha,
        preservedReplicaCount,
      )) return observation;
      if (
        observation.snapshot.deployment.commitHash === candidateSha
        && ["FAILED", "CRASHED", "REMOVED", "CANCELLED", "SKIPPED"]
          .includes(observation.snapshot.latestDeployment.status)
      ) return null;
    } catch {
      // Reconciliation remains read-only and bounded. A transient observation
      // failure never causes a second upload.
    }
    if (dependencies.now().getTime() >= deadline) break;
    await dependencies.sleep(policy.postflightContract.pollIntervalSeconds * 1000);
  } while (dependencies.now().getTime() <= deadline);
  return null;
}

function safeDate(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return new Date(0).toISOString();
  }
  return value.toISOString();
}

function safeFailureCode(error: unknown): PermanentStagingAppDeploymentFailureCode {
  const candidate = error instanceof Error ? error.message : "";
  return SAFE_FAILURE_CODE_SET.has(candidate)
    ? candidate as PermanentStagingAppDeploymentFailureCode
    : "unexpected_failure";
}

function terminalFailureCode(
  checks: PermanentStagingAppDeploymentExecutorChecks,
  writeAttempts: 0 | 1,
): PermanentStagingAppDeploymentFailureCode {
  if (!checks.boundaryPostflightExact) return "boundary_postflight_failed";
  if (checks.targetPostflightAttempted && !checks.targetPostflightExact) {
    return "target_postflight_failed";
  }
  if (writeAttempts === 1 && !checks.deploymentExact) {
    return "reconciliation_failed";
  }
  return "terminal_validation_failed";
}

function summary(receipt: PermanentStagingAppDeploymentExecutorReceipt): string {
  return `${JSON.stringify({
    candidateSha: receipt.candidateSha,
    command: "railway-application-deploy",
    ok: ["deployed", "already_deployed", "reconciled_success"]
      .includes(receipt.outcome),
    outcome: receipt.outcome,
    failureCode: receipt.failureCode,
    receiptSha256: sha256(canonicalJson(receipt)),
    target: receipt.target,
    writeAttempts: receipt.writeAttempts,
  })}\n`;
}

export async function runPermanentStagingAppDeploymentExecutor(
  argv: readonly string[] = process.argv.slice(2),
  overrides: Partial<ExecutorDependencies> = {},
): Promise<0 | 1> {
  const provisional = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  const dependencies: ExecutorDependencies = {
    ...provisional,
    queryTarget: overrides.queryTarget ?? ((
      policy,
      environmentId,
      expectedReplicaCounts,
      publicOrigin,
      token,
    ) => defaultQueryTarget(
      provisional.fetchImpl,
      policy,
      environmentId,
      expectedReplicaCounts,
      publicOrigin,
      token,
    )),
    probeRuntime: overrides.probeRuntime ?? ((
      origin,
      exactCandidateSha,
      exactPolicy,
      environmentId,
      deploymentId,
    ) => defaultProbeRuntime(
      provisional.fetchImpl,
      origin,
      exactCandidateSha,
      exactPolicy,
      environmentId,
      deploymentId,
    )),
    validateWriteToken: overrides.validateWriteToken ?? ((...args) =>
      defaultValidateWriteToken(provisional.fetchImpl, ...args)),
  };
  const startedAt = safeDate(dependencies.now);
  const checks = emptyChecks();
  let candidateSha: string | null = null;
  let policy: PermanentStagingAppDeploymentPolicy | null = null;
  let evidenceDir: string | null = null;
  let sourceAuthority: SourceAuthority | null = null;
  let cliAuthority: CliAuthority | null = null;
  let preflight: ProviderObservation | null = null;
  let reconciledCandidate: ProviderObservation | null = null;
  let postflight: ProviderObservation | null = null;
  let runtime: RuntimeObservation | null = null;
  let targetToken: string | null = null;
  let writeAttempts: 0 | 1 = 0;
  let acknowledgement: PermanentStagingAppDeploymentExecutorReceipt["acknowledgement"] =
    "not_attempted";
  let intentSha256: string | null = null;
  let cliOutputSha256: string | null = null;
  let boundaryPreflightSha256: string | null = null;
  let boundaryPostflightSha256: string | null = null;
  let outcome: PermanentStagingAppDeploymentExecutorReceipt["outcome"] = "blocked";
  let failureCode: PermanentStagingAppDeploymentFailureCode | null = null;
  let preflightAlreadyCandidate = false;
  let preservedReplicaCount: number | null = null;
  let parsedArgs: ReturnType<typeof parseArguments> | null = null;
  let writeResult: CommandResult | null = null;
  let workerFencePrerequisite:
    PermanentStagingAppDeploymentExecutorReceipt["workerFencePrerequisite"] = null;
  let workerFenceVerification:
    ProductionDeploymentWorkerFencePrerequisiteVerification | null = null;

  try {
    parsedArgs = parseArguments(argv);
    candidateSha = parsedArgs.candidateSha;
    evidenceDir = parsedArgs.evidenceDir;
    assertEvidenceDirectory(evidenceDir);
    const policyPath = path.resolve(dependencies.cwd, parsedArgs.policyPath);
    policy = parsePermanentStagingAppDeploymentPolicy(
      fs.readFileSync(policyPath, "utf8"),
    );
    if (!policy) throw new Error("policy_invalid");
    checks.policyExact = true;
    if (
      dependencies.env.GITHUB_ACTIONS !== "true"
      || dependencies.env.GITHUB_RUN_ATTEMPT !== "1"
      || dependencies.env.GITHUB_REF !== policy.target.requiredGitRef
      || dependencies.env.GITHUB_SHA !== candidateSha
    ) throw new Error("github_authority_failed");
    checks.githubMainExact = true;
    if (
      sha256(fs.readFileSync(path.resolve(dependencies.cwd,
        policy.mutationBoundary.policyPath)))
        !== policy.mutationBoundary.policySha256
    ) throw new Error("boundary_policy_drift");
    checks.costPolicyExact = costPolicyExact(policy, dependencies.cwd);
    if (!checks.costPolicyExact) throw new Error("cost_policy_invalid");

    const productionWorkerFenceRunId =
      parsedArgs.productionWorkerFenceRunId
      ?? dependencies.env.PINTPATH_PRODUCTION_DEPLOYMENT_FENCE_RUN_ID
      ?? null;
    const productionWorkerFenceVerificationFile =
      parsedArgs.productionWorkerFenceVerificationFile
      ?? dependencies.env
        .PINTPATH_PRODUCTION_DEPLOYMENT_WORKER_FENCE_VERIFICATION_FILE
      ?? null;
    if (policy.target.name === "production") {
      const currentRunId = dependencies.env.GITHUB_RUN_ID ?? "";
      if (
        !policy.workerFencePrerequisiteContract
        || !productionWorkerFenceRunId
        || !RUN_ID_PATTERN.test(productionWorkerFenceRunId)
        || !RUN_ID_PATTERN.test(currentRunId)
        || !productionWorkerFenceVerificationFile
      ) throw new Error("worker_fence_prerequisite_failed");
      try {
        const prerequisiteSource = readPrivatePrerequisite(
          productionWorkerFenceVerificationFile,
          evidenceDir,
        );
        workerFenceVerification =
          dependencies.validateProductionWorkerFencePrerequisite(
            prerequisiteSource,
            {
              candidateSha,
              currentRunId,
              fenceRunId: productionWorkerFenceRunId,
              now: dependencies.now(),
            },
          );
        workerFencePrerequisite = {
          runId: workerFenceVerification.workerFence.runId,
          verificationSha256: sha256(prerequisiteSource),
          bindingSha256: workerFenceVerification.workerFence.bindingSha256,
          terminalSha256: workerFenceVerification.workerFence.terminalSha256,
          deploymentIdSha256:
            workerFenceVerification.workerFence.deploymentIdSha256,
        };
        checks.workerFencePrerequisiteExact =
          workerFencePrerequisite.runId === productionWorkerFenceRunId
          && workerFenceVerification.candidateSha === candidateSha
          && workerFenceVerification.consumer.runId === currentRunId
          && SHA256_PATTERN.test(workerFencePrerequisite.verificationSha256)
          && SHA256_PATTERN.test(workerFencePrerequisite.bindingSha256)
          && SHA256_PATTERN.test(workerFencePrerequisite.terminalSha256)
          && SHA256_PATTERN.test(workerFencePrerequisite.deploymentIdSha256);
      } catch {
        throw new Error("worker_fence_prerequisite_failed");
      }
      if (!checks.workerFencePrerequisiteExact) {
        throw new Error("worker_fence_prerequisite_failed");
      }
    } else {
      if (
        productionWorkerFenceRunId !== null
        || productionWorkerFenceVerificationFile !== null
        || policy.workerFencePrerequisiteContract !== undefined
      ) throw new Error("worker_fence_prerequisite_failed");
      checks.workerFencePrerequisiteExact = true;
      checks.workerFenceDeploymentContinuityExact = true;
    }

    sourceAuthority = await dependencies.createSourceAuthority(
      dependencies.cwd,
      candidateSha,
      dependencies.env,
    );
    checks.sourceAuthorityExact = sourceAuthority.candidateSha === candidateSha
      && SHA1_PATTERN.test(sourceAuthority.treeSha)
      && SHA256_PATTERN.test(sourceAuthority.archiveSha256)
      && SHA256_PATTERN.test(sourceAuthority.snapshotManifestSha256)
      && path.isAbsolute(sourceAuthority.snapshotPath)
      && path.isAbsolute(sourceAuthority.deploymentPath);
    if (!checks.sourceAuthorityExact) throw new Error("source_authority_failed");
    cliAuthority = await dependencies.validateCli(policy, dependencies);
    checks.cliExact = true;
    const writeToken = dependencies.env.PINTPATH_RAILWAY_WRITE_TOKEN;
    if (typeof writeToken !== "string" || !SAFE_TOKEN_PATTERN.test(writeToken)) {
      throw new Error("write_token_missing");
    }
    checks.writeTokenScopeExact = await dependencies.validateWriteToken(
      policy,
      writeToken,
    );
    if (!checks.writeTokenScopeExact) throw new Error("write_token_scope_invalid");

    if (policy.prerequisite) {
      const prerequisiteToken = tokenForTarget("permanent-staging", dependencies.env);
      const prerequisite = await dependencies.queryTarget(
        policy,
        policy.prerequisite.environmentId,
        [policy.prerequisite.expectedReplicaCount],
        policy.prerequisite.publicOrigin,
        prerequisiteToken,
      );
      if (!deploymentHealthy(
        prerequisite,
        policy,
        candidateSha,
        policy.prerequisite.expectedReplicaCount,
      )) throw new Error("prerequisite_failed");
      await dependencies.probeRuntime(
        policy.prerequisite.publicOrigin,
        candidateSha,
        policy,
        policy.prerequisite.environmentId,
        prerequisite.snapshot.deployment.id,
      );
    }
    checks.prerequisiteExact = true;

    const boundaryPreflight = await dependencies.runBoundary(policy, dependencies.env);
    boundaryPreflightSha256 = writeEvidence(
      evidenceDir,
      "railway-boundary-preflight.json",
      boundaryPreflight.source,
    );
    checks.boundaryPreflightExact = boundaryPreflight.ok;
    if (!boundaryPreflight.ok) throw new Error("boundary_preflight_failed");

    targetToken = tokenForTarget(policy.target.name, dependencies.env);
    preflight = await dependencies.queryTarget(
      policy,
      policy.target.environmentId,
      policy.target.allowedReplicaCounts,
      policy.target.publicOrigin,
      targetToken,
    );
    preservedReplicaCount = preflight.snapshot.numReplicas;
    checks.targetPreflightExact = preflight.tokenScopeExact
      && preflight.patchEmpty
      && SHA256_PATTERN.test(preflight.collateralSha256)
      && (policy.target.allowedReplicaCounts as readonly number[])
        .includes(preservedReplicaCount);
    checks.gitAutodeployAbsent = preflight.gitAutodeployAbsent;
    checks.collateralInventoryExact = checks.targetPreflightExact;
    if (!checks.targetPreflightExact) throw new Error("target_preflight_failed");
    if (!checks.gitAutodeployAbsent) throw new Error("git_autodeploy_active");
    if (policy.target.name === "production") {
      checks.workerFenceDeploymentContinuityExact =
        workerFencePrerequisite !== null
        && railwayDeploymentIdentityIdSha256(
            "deployment",
            preflight.snapshot.deployment.id,
          ) === workerFencePrerequisite.deploymentIdSha256;
      if (!checks.workerFenceDeploymentContinuityExact) {
        throw new Error("worker_fence_prerequisite_failed");
      }
    }
    preflightAlreadyCandidate = preflight.snapshot.deployment.commitHash === candidateSha;
    if (preflightAlreadyCandidate && !deploymentHealthy(
      preflight,
      policy,
      candidateSha,
      preservedReplicaCount,
    )) {
      throw new Error("candidate_preexisting_not_healthy");
    }

    const intent = {
      schemaVersion: "pintpath-railway-application-deployment-intent/v2",
      operation: PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION,
      target: policy.target.name,
      candidateSha,
      treeSha: sourceAuthority.treeSha,
      sourceArchiveSha256: sourceAuthority.archiveSha256,
      sourceSnapshotManifestSha256: sourceAuthority.snapshotManifestSha256,
      previousDeploymentIdSha256: railwayDeploymentIdentityIdSha256(
        "deployment",
        preflight.snapshot.deployment.id,
      ),
      workerFencePrerequisite,
      preservedReplicaCount,
      createdAt: safeDate(dependencies.now),
      maximumWriteAttempts: 1,
      automaticRetryAllowed: false,
    } as const;
    intentSha256 = writeEvidence(
      evidenceDir,
      "deployment-intent.json",
      canonicalJson(intent),
    );
    checks.durableIntentExact = true;
    sourceAuthority.reassert();
    checks.sourceReasserted = true;

    if (!preflightAlreadyCandidate) {
      cliAuthority.assertExact();
      const message = `pintpath:${policy.target.name}:${candidateSha}:${intentSha256}`;
      writeAttempts = 1;
      try {
        writeResult = await dependencies.runCommand(
          cliAuthority.executablePath,
          [
            "up",
            sourceAuthority.deploymentPath,
            "--path-as-root",
            "--no-gitignore",
            "--detach",
            "--json",
            "--project",
            policy.projectId,
            "--environment",
            policy.target.environmentId,
            "--service",
            policy.target.serviceId,
            "--message",
            message,
          ],
          {
            cwd: sourceAuthority.deploymentPath,
            timeoutMs: 120_000,
            maximumOutputBytes: 2 * 1024 * 1024,
            env: {
              CI: "true",
              NO_COLOR: "1",
              RAILWAY_TOKEN: writeToken,
            },
          },
        );
      } finally {
        checks.sourceReasserted = false;
        try {
          sourceAuthority.reassert();
          checks.sourceReasserted = true;
        } finally {
          cliAuthority.assertExact();
        }
      }
      cliOutputSha256 = sha256(`${writeResult.stdout}\0${writeResult.stderr}`);
      acknowledgement = writeResult.code === 0 && !writeResult.timedOut
        ? "received"
        : "missing_or_failed";
    }
    checks.writeAttemptedAtMostOnce = writeAttempts <= 1;
    reconciledCandidate = preflightAlreadyCandidate
      ? preflight
      : await pollForCandidate(
        policy,
        targetToken,
        candidateSha,
        preservedReplicaCount,
        dependencies,
      );
    if (reconciledCandidate) {
      checks.deploymentExact = deploymentHealthy(
        reconciledCandidate,
        policy,
        candidateSha,
        preservedReplicaCount,
      );
      runtime = policy.postflightContract.runtimeProbeRequired
        ? await dependencies.probeRuntime(
          policy.target.publicOrigin,
          candidateSha,
          policy,
          policy.target.environmentId,
          reconciledCandidate.snapshot.deployment.id,
        )
        : null;
      checks.runtimeHealthExact = true;
      checks.runtimeStartupExact = true;
      checks.runtimeReadinessExact = true;
    }
    outcome = reconciledCandidate === null
      ? "mutation_uncertain"
      : preflightAlreadyCandidate
        ? "already_deployed"
        : acknowledgement === "received"
          ? "deployed"
          : "reconciled_success";
  } catch (error) {
    failureCode = safeFailureCode(error);
    if (writeAttempts === 1) {
      acknowledgement = acknowledgement === "received"
        ? acknowledgement
        : "missing_or_failed";
      outcome = "mutation_uncertain";
    }
  } finally {
    try { cliAuthority?.close(); } catch {
      failureCode ??= "cli_invalid";
      checks.cliExact = false;
    }
    try { sourceAuthority?.close(); } catch {
      failureCode ??= "source_cleanup_failed";
      checks.sourceReasserted = false;
    }
    if (policy && evidenceDir) {
      if (
        preflight
        && targetToken
        && candidateSha
        && preservedReplicaCount !== null
      ) {
        checks.targetPostflightAttempted = true;
        try {
          postflight = await dependencies.queryTarget(
            policy,
            policy.target.environmentId,
            [preservedReplicaCount],
            policy.target.publicOrigin,
            targetToken,
          );
          checks.reconciliationCompleted = true;
          checks.deploymentExact = deploymentHealthy(
            postflight,
            policy,
            candidateSha,
            preservedReplicaCount,
          );
          checks.topologyPreserved =
            postflight.snapshot.numReplicas === preflight.snapshot.numReplicas;
          checks.collateralStateUnchanged = collateralUnchanged(
            preflight,
            postflight,
          );
          checks.targetPostflightExact = checks.deploymentExact
            && checks.topologyPreserved
            && checks.collateralStateUnchanged
            && (reconciledCandidate === null
              || providerDeploymentUnchanged(reconciledCandidate, postflight));
        } catch (error) {
          failureCode ??= safeFailureCode(error);
          checks.targetPostflightExact = false;
          checks.reconciliationCompleted = false;
          checks.topologyPreserved = false;
        }
      }
      try {
        const boundaryPostflight = await dependencies.runBoundary(
          policy,
          dependencies.env,
        );
        boundaryPostflightSha256 = writeEvidence(
          evidenceDir,
          "railway-boundary-postflight.json",
          boundaryPostflight.source,
        );
        checks.boundaryPostflightExact = boundaryPostflight.ok;
      } catch (error) {
        failureCode ??= safeFailureCode(error);
        checks.boundaryPostflightExact = false;
      }
    }
    try { sourceAuthority?.cleanup(); } catch {
      failureCode ??= "source_cleanup_failed";
      checks.sourceReasserted = false;
    }
  }

  const successfulOutcome = ["deployed", "already_deployed", "reconciled_success"]
    .includes(outcome);
  const requiredChecks = [
    checks.policyExact,
    checks.githubMainExact,
    checks.sourceAuthorityExact,
    checks.cliExact,
    checks.writeTokenScopeExact,
    checks.costPolicyExact,
    checks.prerequisiteExact,
    checks.workerFencePrerequisiteExact,
    checks.workerFenceDeploymentContinuityExact,
    checks.boundaryPreflightExact,
    checks.targetPreflightExact,
    checks.durableIntentExact,
    checks.sourceReasserted,
    checks.writeAttemptedAtMostOnce,
    checks.targetPostflightAttempted,
    checks.targetPostflightExact,
    checks.reconciliationCompleted,
    checks.topologyPreserved,
    checks.deploymentExact,
    checks.runtimeHealthExact,
    checks.runtimeStartupExact,
    checks.runtimeReadinessExact,
    checks.collateralStateUnchanged,
    checks.gitAutodeployAbsent,
    checks.collateralInventoryExact,
    checks.boundaryPostflightExact,
  ];
  if (!successfulOutcome || requiredChecks.some((check) => !check)) {
    outcome = writeAttempts === 1 ? "mutation_uncertain" : "blocked";
    failureCode ??= terminalFailureCode(checks, writeAttempts);
  }
  const completedAt = safeDate(dependencies.now);
  const receiptBase: Omit<PermanentStagingAppDeploymentExecutorReceipt,
    "checks"> = {
    schemaVersion: PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA,
    operation: PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION,
    executorState: PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE,
    target: policy?.target.name ?? null,
    outcome,
    failureCode,
    candidateSha,
    startedAt,
    completedAt,
    writeAttempts,
    acknowledgement,
    previousDeploymentIdSha256: preflight
      ? railwayDeploymentIdentityIdSha256("deployment", preflight.snapshot.deployment.id) ?? null
      : null,
    deploymentIdSha256: postflight
      ? railwayDeploymentIdentityIdSha256("deployment", postflight.snapshot.deployment.id) ?? null
      : null,
    intentSha256,
    cliOutputSha256,
    boundaryPreflightSha256,
    boundaryPostflightSha256,
    collateralSnapshotSha256s: {
      before: preflight?.collateralSha256 ?? null,
      after: postflight?.collateralSha256 ?? null,
    },
    replicaCounts: {
      before: preflight?.snapshot.numReplicas ?? null,
      after: postflight?.snapshot.numReplicas ?? null,
    },
    runtimeResponseSha256s: {
      health: runtime?.health.responseSha256 ?? null,
      startup: runtime?.startup.responseSha256 ?? null,
      ready: runtime?.ready.responseSha256 ?? null,
    },
    workerFencePrerequisite,
  };
  let receipt: PermanentStagingAppDeploymentExecutorReceipt = {
    ...receiptBase,
    checks: Object.freeze({ ...checks, terminalEvidenceExact: false }),
  };
  if (evidenceDir) {
    try {
      checks.terminalEvidenceExact = true;
      receipt = {
        ...receiptBase,
        checks: Object.freeze({ ...checks }),
      };
      writeEvidence(
        evidenceDir,
        "deployment-receipt.json",
        canonicalJson(receipt),
      );
    } catch {
      checks.terminalEvidenceExact = false;
      outcome = writeAttempts === 1 ? "mutation_uncertain" : "blocked";
      failureCode ??= "terminal_evidence_failed";
      receipt = {
        ...receiptBase,
        outcome,
        failureCode,
        checks: Object.freeze({ ...checks }),
      };
    }
  }
  dependencies.writeOutput(summary(receipt));
  return ["deployed", "already_deployed", "reconciled_success"]
    .includes(receipt.outcome)
    && receipt.checks.terminalEvidenceExact
    ? 0
    : 1;
}

export const PERMANENT_STAGING_APP_DEPLOYMENT_BLOCKED_RECEIPT = Object.freeze({
  schemaVersion: PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA,
  operation: PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION,
  executorState: PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE,
  target: null,
  outcome: "blocked",
  failureCode: "unexpected_failure",
} as const);

export const permanentStagingAppDeploymentExecutorInternals = Object.freeze({
  TARGET_LOCKS,
  costPolicyExact,
  deploymentHealthy,
  holdSnapshotRootDirectory,
  parseArguments,
  parseCollateralSnapshot,
  queryCollateralSnapshot,
  parseDiscoveryDeploymentId,
  policyMatchesLock,
  providerDeploymentUnchanged,
  runtimeMatches,
  safeFailureCode,
  snapshotManifestSha256,
  validateCli,
  validatedProviderObservation,
});
