// Isolated pilot variant of the existing source-upload executor. The historical
// production/staging producer remains byte-identical for its attestation pins.
// This entry point accepts only the exact bar-pilot staging policy.
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
  parseRailwayApplicationDeploymentAttestationTokenScopeResponse,
  type RailwayApplicationDeploymentAttestationProviderSnapshot,
  type RailwayApplicationDeploymentAttestationRuntimeResponse,
} from "../../src/lib/railway-application-deployment-attestation.js";
import {
  canonicalProtectedSourceArchiveManifest,
  parseProtectedSourceArchiveManifest,
  parseProtectedSourceArchiveRuntimeResponse,
  type ProtectedSourceArchiveIdentity,
  type ProtectedSourceArchiveManifest,
} from "../../src/lib/protected-source-archive.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../../src/lib/railway-deployment-identity.js";
import {
  parseProductionDeploymentWorkerFencePrerequisiteVerification,
  type ProductionDeploymentWorkerFencePrerequisiteVerification,
} from "../verify-production-maintenance-role-limit-prerequisites.js";
import {
  parseRailwayMultiRegionReplicaTopology,
  type RailwayRegionReplicaCount,
} from "./railway-multi-region-replica-topology.js";
import { readTrustedRegularFile } from "./trusted-filesystem.js";
import {
  BAR_PILOT_STAGING_POLICY_ID,
  BAR_PILOT_STOPPED_SOURCE_SHA,
  BAR_PILOT_PACKAGE_LOCK_SHA256,
  barPilotCurrentDeploymentExact,
  barPilotStoppedDeploymentExact,
} from "./bar-pilot-staging-contract.js";
import {
  BAR_PILOT_FAILED_STARTUP_RECOVERY,
  barPilotFailedStartupDeploymentExact,
  barPilotFailedStartupRecoveryRequested,
  readBarPilotFailedStartupCorrectionProof,
} from "./bar-pilot-failed-startup-recovery.js";
import {
  assertBarPilotPreviousCandidateAncestor,
  barPilotPreviousCandidateSha,
} from "./bar-pilot-healthy-rollout.js";

export const PERMANENT_STAGING_APP_DEPLOYMENT_POLICY_SCHEMA =
  "pintpath-railway-application-deployment-policy/v6" as const;
export const PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA =
  "pintpath-railway-application-deployment-executor/v6" as const;
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
  "failed_startup_recovery_invalid",
  "git_autodeploy_active",
  "github_authority_failed",
  "metadata_token_missing",
  "policy_invalid",
  "prerequisite_failed",
  "provider_query_failed",
  "provider_target_mismatch",
  "reconciliation_failed",
  "runtime_probe_failed",
  "immediate_prewrite_failed",
  "fenced_runtime_present",
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
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
  $deploymentId: String!
) {
  environment(id: $environmentId, projectId: $projectId) {
    id
    config(decryptVariables: false)
  }
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
    configuredTopologyContract: Object.freeze({
      authoritativeSource: "environment.config(decryptVariables:false)",
      configuredReplicaCounts: Object.freeze([1] as const),
      allowedConfiguredRegions: Object.freeze([
        "asia-southeast1-eqsg3a",
        "europe-west4-drams3a",
      ] as const),
      solePositiveRegion: "asia-southeast1-eqsg3a",
      zeroOnlyRegions: Object.freeze(["europe-west4-drams3a"] as const),
      legacyReplicaCountRole: "nullable-observation-only",
      immediateProviderReassertionRequired: true,
      postflightProviderReassertionRequired: true,
    }),
    activeAutomaticMaintenanceEnabled: true,
    fencedConfiguredTopologyContract: Object.freeze({
      authoritativeSource: "environment.config(decryptVariables:false)",
      configuredReplicaCounts: Object.freeze([0] as const),
      allowedConfiguredRegions: Object.freeze([
        "asia-southeast1-eqsg3a",
        "europe-west4-drams3a",
      ] as const),
      solePositiveRegion: null,
      zeroOnlyRegions: Object.freeze([
        "asia-southeast1-eqsg3a",
        "europe-west4-drams3a",
      ] as const),
      legacyReplicaCountRole: "nullable-observation-only",
      immediateProviderReassertionRequired: true,
      postflightProviderReassertionRequired: true,
    }),
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
    configuredTopologyContract: Object.freeze({
      authoritativeSource: "environment.config(decryptVariables:false)",
      configuredReplicaCounts: Object.freeze([1, 2] as const),
      allowedConfiguredRegions: Object.freeze([
        "asia-southeast1-eqsg3a",
      ] as const),
      solePositiveRegion: "asia-southeast1-eqsg3a",
      zeroOnlyRegions: Object.freeze([] as const),
      legacyReplicaCountRole: "nullable-observation-only",
      immediateProviderReassertionRequired: true,
      postflightProviderReassertionRequired: true,
    }),
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
    packageLockSha256: z.union([z.literal(PACKAGE_LOCK_SHA256), z.literal(BAR_PILOT_PACKAGE_LOCK_SHA256)]),
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
  configuredTopologyContract: z.object({
    authoritativeSource: z.literal(
      "environment.config(decryptVariables:false)",
    ),
    configuredReplicaCounts: z.union([
      z.tuple([z.literal(0)]),
      z.tuple([z.literal(1)]),
      z.tuple([z.literal(1), z.literal(2)]),
    ]),
    allowedConfiguredRegions: z.union([
      z.tuple([z.literal("us-west2")]),
      z.tuple([z.literal("asia-southeast1-eqsg3a")]),
      z.tuple([
        z.literal("asia-southeast1-eqsg3a"),
        z.literal("europe-west4-drams3a"),
      ]),
    ]),
    solePositiveRegion: z.union([
      z.null(),
      z.literal("us-west2"),
      z.literal("asia-southeast1-eqsg3a"),
    ]),
    zeroOnlyRegions: z.union([
      z.tuple([]),
      z.tuple([z.literal("europe-west4-drams3a")]),
      z.tuple([
        z.literal("asia-southeast1-eqsg3a"),
        z.literal("europe-west4-drams3a"),
      ]),
    ]),
    legacyReplicaCountRole: z.literal("nullable-observation-only"),
    immediateProviderReassertionRequired: z.literal(true),
    postflightProviderReassertionRequired: z.literal(true),
  }).strict(),
  fencedDeploymentContract: z.object({
    configuredTopologySource: z.literal(
      "environment.config(decryptVariables:false)",
    ),
    configuredReplicaCount: z.literal(0),
    allowedConfiguredRegions: z.tuple([
      z.literal("asia-southeast1-eqsg3a"),
      z.literal("europe-west4-drams3a"),
    ]),
    legacyReplicaCountRole: z.literal("nullable-observation-only"),
    immediateProviderReassertionRequired: z.literal(true),
    runtimeAbsentImmediatelyBeforeWriteRequired: z.literal(true),
    runtimeAbsentPostflightRequired: z.literal(true),
  }).strict().optional(),
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

function canonicalKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalKeyOrder);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [
    key,
    canonicalKeyOrder(record[key]),
  ]));
}

function canonicalTopologyJson(value: unknown): string {
  return `${JSON.stringify(canonicalKeyOrder(value), null, 2)}\n`;
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
  let configuredTopologyContractExact: boolean;
  let fencedDeploymentContractExact: boolean;
  if (policy.target.name === "permanent-staging") {
    const stagingLock = TARGET_LOCKS["permanent-staging"];
    const barPilot = policy.policyId === BAR_PILOT_STAGING_POLICY_ID;
    const fenced = !policy.postflightContract.automaticMaintenanceEnabled;
    policyIdExact = barPilot || policy.policyId === (
      fenced
        ? stagingLock.fencedPolicyId
        : stagingLock.policyId
    );
    automaticMaintenanceStateAllowed = (
      stagingLock.allowedAutomaticMaintenanceStates as readonly boolean[]
    ).includes(policy.postflightContract.automaticMaintenanceEnabled);
    if (barPilot ? (policy.postflightContract.automaticMaintenanceEnabled
      || !policy.postflightContract.runtimeProbeRequired)
      : policy.postflightContract.automaticMaintenanceEnabled
        !== policy.postflightContract.runtimeProbeRequired) return false;
    expectedReplicaCounts = fenced && !barPilot
      ? stagingLock.fencedAllowedReplicaCounts
      : stagingLock.allowedReplicaCounts;
    configuredTopologyContractExact = canonicalJson(
      policy.configuredTopologyContract,
    ) === canonicalJson(
      barPilot
        ? {
            ...stagingLock.configuredTopologyContract,
            allowedConfiguredRegions: ["us-west2"],
            solePositiveRegion: "us-west2",
            zeroOnlyRegions: [],
          }
        : fenced
        ? stagingLock.fencedConfiguredTopologyContract
        : stagingLock.configuredTopologyContract,
    );
    fencedDeploymentContractExact = fenced && !barPilot
      ? policy.fencedDeploymentContract?.configuredTopologySource
          === "environment.config(decryptVariables:false)"
        && policy.fencedDeploymentContract.configuredReplicaCount === 0
        && canonicalJson(policy.fencedDeploymentContract.allowedConfiguredRegions)
          === canonicalJson(
            stagingLock.fencedConfiguredTopologyContract
              .allowedConfiguredRegions,
          )
        && policy.fencedDeploymentContract.legacyReplicaCountRole
          === "nullable-observation-only"
        && policy.fencedDeploymentContract.immediateProviderReassertionRequired
          === true
        && policy.fencedDeploymentContract
          .runtimeAbsentImmediatelyBeforeWriteRequired === true
        && policy.fencedDeploymentContract.runtimeAbsentPostflightRequired === true
      : policy.fencedDeploymentContract === undefined;
  } else {
    const productionLock = TARGET_LOCKS.production;
    policyIdExact = policy.policyId === productionLock.policyId;
    automaticMaintenanceStateAllowed =
      policy.postflightContract.automaticMaintenanceEnabled
        === productionLock.automaticMaintenanceEnabled;
    if (!policy.postflightContract.runtimeProbeRequired) return false;
    expectedReplicaCounts = productionLock.allowedReplicaCounts;
    configuredTopologyContractExact = canonicalJson(
      policy.configuredTopologyContract,
    ) === canonicalJson(productionLock.configuredTopologyContract);
    fencedDeploymentContractExact =
      policy.fencedDeploymentContract === undefined;
  }
  return policyIdExact
    && policy.sourceContract.packageLockSha256 === (policy.policyId === BAR_PILOT_STAGING_POLICY_ID
      ? BAR_PILOT_PACKAGE_LOCK_SHA256 : PACKAGE_LOCK_SHA256)
    && configuredTopologyContractExact
    && fencedDeploymentContractExact
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

function isFencedDeploymentPolicy(
  policy: PermanentStagingAppDeploymentPolicy,
): boolean {
  return policy.target.name === "permanent-staging"
    && policy.fencedDeploymentContract !== undefined;
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
    if (policy.policyId !== BAR_PILOT_STAGING_POLICY_ID
      || canonicalJson(policy) !== source || !policyMatchesLock(policy)) return null;
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
  readonly sourceArchive: ProtectedSourceArchiveIdentity;
  readonly snapshotManifestSha256: string;
  readonly snapshotPath: string;
  readonly deploymentPath: string;
  readonly close: () => void;
  readonly cleanup: () => void;
  readonly reassert: () => void;
}

export interface PilotProviderSnapshot extends Omit<
  RailwayApplicationDeploymentAttestationProviderSnapshot, "deployment"
> {
  readonly deployment: Omit<
    RailwayApplicationDeploymentAttestationProviderSnapshot["deployment"], "commitHash" | "imageDigest"
  > & {
    readonly commitHash: string | null;
    readonly imageDigest: string | null;
    readonly providerSource: string | null;
    readonly providerMessage: string | null;
    readonly providerMessageField: string | null;
  };
}

interface UploadIdentity {
  readonly deploymentId: string | null;
  readonly message: string;
  readonly sourceArchive: ProtectedSourceArchiveIdentity;
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

interface ConfiguredTopologyEvidence {
  readonly configuredReplicas: number;
  readonly configuredRegions: readonly RailwayRegionReplicaCount[];
  readonly configuredTopologySha256: string;
}

interface ProviderObservation {
  readonly tokenScopeExact: boolean;
  readonly patchEmpty: boolean;
  readonly gitAutodeployAbsent: boolean;
  readonly collateralSha256: string;
  readonly configuredTopology: ConfiguredTopologyEvidence;
  readonly snapshot: PilotProviderSnapshot;
}

type PilotRuntimeResponse = NonNullable<
  ReturnType<typeof parseProtectedSourceArchiveRuntimeResponse>
>;
interface RuntimeObservation {
  readonly health: PilotRuntimeResponse;
  readonly startup: PilotRuntimeResponse;
  readonly ready: PilotRuntimeResponse;
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
    expectedPackageLockSha256?: string,
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
    expectedSourceArchive?: ProtectedSourceArchiveIdentity,
  ) => Promise<RuntimeObservation>;
  readonly probeRuntimeAbsent: (
    origin: string,
  ) => Promise<boolean>;
  readonly probeRuntimeAbsentImmediately: (
    origin: string,
  ) => Promise<boolean>;
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
  configuredTopologyExact: boolean;
  immediatePrewriteExact: boolean;
  fencedRuntimeAbsentBeforeWrite: boolean;
  fencedRuntimeAbsentPostflight: boolean;
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
  readonly legacyReplicaCounts: {
    readonly before: number | null;
    readonly immediatelyBeforeWrite: number | null;
    readonly after: number | null;
  };
  readonly configuredTopology: {
    readonly authoritativeSource:
      "environment.config(decryptVariables:false)";
    readonly before: ConfiguredTopologyEvidence | null;
    readonly immediatelyBeforeWrite: ConfiguredTopologyEvidence | null;
    readonly after: ConfiguredTopologyEvidence | null;
  };
  readonly runtimeAbsence: {
    readonly required: boolean;
    readonly immediatelyBeforeWrite: boolean | null;
    readonly postflight: boolean | null;
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
    configuredTopologyExact: false,
    immediatePrewriteExact: false,
    fencedRuntimeAbsentBeforeWrite: false,
    fencedRuntimeAbsentPostflight: false,
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

function readSourceArchiveSha256(filename: string): string {
  const bytes = readTrustedRegularFile(filename, {
    minBytes: 1,
    maxBytes: 1024 * 1024 * 1024,
    requireExactMode: 0o600,
    requireOwner: true,
  });
  try {
    return sha256(bytes);
  } finally {
    bytes.fill(0);
  }
}

function materializeSourceArchiveIdentity(
  snapshotPath: string,
  candidateSha: string,
  treeSha: string,
  archiveSha256: string,
): ProtectedSourceArchiveIdentity {
  const sourceManifest: ProtectedSourceArchiveManifest = {
    schemaVersion: "protected-source-archive/v1",
    candidateSha,
    treeSha,
    sourceArchiveSha256: archiveSha256,
    sourceBaseManifestSha256: snapshotManifestSha256(snapshotPath),
    uploadNonce: crypto.randomBytes(32).toString("hex"),
  };
  const sourceManifestBytes = canonicalProtectedSourceArchiveManifest(sourceManifest);
  if (!parseProtectedSourceArchiveManifest(sourceManifestBytes)) {
    throw new Error("source_authority_failed");
  }
  // The sole documented augmentation of the reviewed git archive. Exclusive
  // creation rejects repository-provided provenance. The final held snapshot
  // hash includes these bytes; the private parent excludes other local users.
  fs.writeFileSync(path.join(snapshotPath, ".pintpath-source-archive.json"),
    sourceManifestBytes, { flag: "wx", mode: 0o444 });
  return Object.freeze({
    ...sourceManifest,
    sourceIdentitySha256: sha256(sourceManifestBytes),
  });
}

async function defaultCreateSourceAuthority(
  cwd: string,
  candidateSha: string,
  env: Readonly<Record<string, string | undefined>>,
  expectedPackageLockSha256: string = PACKAGE_LOCK_SHA256,
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
      !== expectedPackageLockSha256
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
    const archiveSha256 = readSourceArchiveSha256(archivePath);
    const sourceArchive = materializeSourceArchiveIdentity(
      snapshotPath, candidateSha, treeSha, archiveSha256,
    );
    const manifestSha256 = snapshotManifestSha256(snapshotPath);
    heldSnapshotRoot = holdSnapshotRootDirectory(snapshotPath);
    const snapshotRoot = heldSnapshotRoot;
    const reassert = () => {
      try {
        snapshotRoot.assertExact();
        const root = fs.lstatSync(privateRoot);
        const snapshot = fs.lstatSync(snapshotPath);
        if (
          !root.isDirectory()
          || root.isSymbolicLink()
          || (root.mode & 0o777) !== 0o700
          || !snapshot.isDirectory()
          || snapshot.isSymbolicLink()
          || (snapshot.mode & 0o777) !== 0o700
          || readSourceArchiveSha256(archivePath) !== archiveSha256
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
      sourceArchive,
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

function parseUploadDeploymentId(source: string): string | null {
  try {
    // Pinned Railway 5.32.0 `up --detach --json` emits exactly this object.
    // A timeout without its deployment ID requires nonce-bound runtime
    // reconciliation, never a second upload.
    if (Buffer.byteLength(source) > 4_096) return null;
    const value = exactRecord(JSON.parse(source), ["deploymentId", "logsUrl"]);
    if (!value || typeof value.deploymentId !== "string"
      || !UUID_PATTERN.test(value.deploymentId)
      || typeof value.logsUrl !== "string" || value.logsUrl.length > 2_048) return null;
    const logsUrl = new URL(value.logsUrl);
    if (logsUrl.protocol !== "https:" || logsUrl.hostname !== "railway.com"
      || logsUrl.username || logsUrl.password || logsUrl.port) return null;
    return value.deploymentId;
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
        // The target service's aggregate count is a nullable legacy
        // observation. Its authoritative topology is captured separately from
        // environment.config(decryptVariables:false).
        numReplicas: node.serviceId === targetServiceId
          ? null
          : node.numReplicas,
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

function configuredTopologyEvidence(
  environmentConfig: unknown,
  serviceId: string,
): ConfiguredTopologyEvidence | null {
  const topology = parseRailwayMultiRegionReplicaTopology(
    environmentConfig,
    serviceId,
  );
  if (topology.kind !== "configured") return null;
  const configuredRegions = Object.freeze(topology.regions.map((entry) =>
    Object.freeze({ ...entry })));
  const evidence = {
    configuredReplicas: topology.configuredTotal,
    configuredRegions,
  } as const;
  return Object.freeze({
    ...evidence,
    configuredTopologySha256: sha256(canonicalTopologyJson(evidence)),
  });
}

function parseProviderSnapshotWithConfiguredTopology(
  source: string,
  policy: PermanentStagingAppDeploymentPolicy,
  environmentId: string,
): {
  readonly snapshot: PilotProviderSnapshot;
  readonly configuredTopology: ConfiguredTopologyEvidence;
} | null {
  try {
    if (Buffer.byteLength(source) > MAX_PROVIDER_BYTES) return null;
    const root = exactRecord(JSON.parse(source), ["data"]);
    const data = exactRecord(root?.data, [
      "environment",
      "serviceInstance",
      "deployment",
    ]);
    const environment = exactRecord(data?.environment, ["id", "config"]);
    if (!data || !environment || environment.id !== environmentId) return null;
    const topology = configuredTopologyEvidence(
      environment.config,
      policy.target.serviceId,
    );
    if (!topology) return null;
    const snapshot = parsePilotProviderSnapshot(data.serviceInstance, data.deployment);
    return snapshot ? { snapshot, configuredTopology: topology } : null;
  } catch {
    return null;
  }
}

function parsePilotProviderSnapshot(
  instanceInput: unknown,
  deploymentInput: unknown,
): PilotProviderSnapshot | null {
  // CLI uploads have no provider Git SHA. Validate the actual fields directly;
  // never manufacture a Git-shaped response for the historical shared parser.
  const uuid = z.string().regex(UUID_PATTERN);
  const summary = z.object({
    id: uuid,
    status: z.string().regex(/^[A-Z_]{1,32}$/),
    deploymentStopped: z.boolean(),
  }).strict();
  const domain = z.object({
    id: uuid,
    domain: z.string().min(1).max(253).refine((value) =>
      value === value.toLowerCase() && !/[\r\n\0/:?#@\s]/.test(value)),
    targetPort: z.number().int().min(1).max(65_535).nullable(),
  }).strict();
  const instanceResult = z.object({
    id: uuid, serviceId: uuid, environmentId: uuid,
    numReplicas: z.number().int().min(0).max(50).nullable(),
    latestDeployment: summary.extend({ snapshotId: uuid }).strict(),
    activeDeployments: z.array(summary).max(100),
    domains: z.object({
      serviceDomains: z.array(domain).max(100),
      customDomains: z.array(domain).max(100),
    }).strict(),
  }).strict().safeParse(instanceInput);
  const deploymentResult = z.object({
    id: uuid, projectId: uuid, environmentId: uuid, serviceId: uuid, snapshotId: uuid,
    meta: z.object({
      commitHash: z.string().regex(SHA1_PATTERN).nullable().optional(),
      imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable().optional(),
      // Railway omits optional patchId for some real deployments. Independent
      // scoped staged-patch reads remain mandatory before and after upload.
      patchId: z.null().optional(),
      source: z.string().min(1).max(128).nullable().optional(),
    }).passthrough(),
  }).strict().safeParse(deploymentInput);
  if (!instanceResult.success || !deploymentResult.success) return null;
  const instance = instanceResult.data;
  const deployment = deploymentResult.data;
  // A failed source upload can terminate before Railway publishes an image
  // digest. Keep that absence explicit so read-only reconciliation can finish;
  // it must never qualify a successful or still-running deployment.
  if (!deployment.meta.imageDigest && (instance.latestDeployment.status !== "FAILED"
    || !instance.latestDeployment.deploymentStopped)) return null;
  const domains = [
    ...instance.domains.serviceDomains.map((value) => ({ kind: "service" as const, ...value })),
    ...instance.domains.customDomains.map((value) => ({ kind: "custom" as const, ...value })),
  ];
  if (new Set(instance.activeDeployments.map((value) => value.id)).size
      !== instance.activeDeployments.length
    || new Set(domains.map((value) => value.id)).size !== domains.length
    || new Set(domains.map((value) => value.domain)).size !== domains.length) return null;
  // The provider's opaque metadata has no documented CLI message key. Record
  // only an actually observed bounded PintPath intent value and its actual key.
  // Its absence cannot replace the required nonce-bound runtime observation.
  const intentMessages = Object.entries(deployment.meta).filter(([key, value]) =>
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)
    && typeof value === "string"
    && /^pintpath:permanent-staging:[a-f0-9]{40}:[a-f0-9]{64}$/.test(value));
  if (intentMessages.length > 1) return null;
  return {
    serviceInstanceId: instance.id,
    serviceId: instance.serviceId,
    environmentId: instance.environmentId,
    numReplicas: instance.numReplicas,
    latestDeployment: instance.latestDeployment,
    activeDeployments: instance.activeDeployments,
    domains,
    deployment: {
      id: deployment.id, projectId: deployment.projectId,
      environmentId: deployment.environmentId, serviceId: deployment.serviceId,
      snapshotId: deployment.snapshotId,
      commitHash: deployment.meta.commitHash ?? null,
      imageDigest: deployment.meta.imageDigest ?? null,
      patchId: null,
      providerSource: deployment.meta.source ?? null,
      providerMessage: intentMessages[0]?.[1] as string | undefined ?? null,
      providerMessageField: intentMessages[0]?.[0] ?? null,
    },
  };
}

function configuredTopologyAllowed(
  policy: PermanentStagingAppDeploymentPolicy,
  topology: ConfiguredTopologyEvidence,
  expectedReplicaCounts: readonly number[],
  environmentId = policy.target.environmentId,
): boolean {
  const contract = environmentId === policy.target.environmentId
    ? policy.configuredTopologyContract
    : environmentId === TARGET_LOCKS["permanent-staging"].environmentId
      ? TARGET_LOCKS["permanent-staging"].configuredTopologyContract
      : null;
  if (!contract) return false;
  if (
    !expectedReplicaCounts.includes(topology.configuredReplicas)
    || !(contract.configuredReplicaCounts as readonly number[])
      .includes(topology.configuredReplicas)
    || topology.configuredRegions.some((entry) =>
      !(contract.allowedConfiguredRegions as readonly string[])
        .includes(entry.region))
    || topology.configuredRegions.some((entry) =>
      (contract.zeroOnlyRegions as readonly string[]).includes(entry.region)
      && entry.numReplicas !== 0)
  ) return false;
  const positive = topology.configuredRegions.filter((entry) =>
    entry.numReplicas > 0);
  if (contract.solePositiveRegion === null) {
    return topology.configuredReplicas === 0 && positive.length === 0;
  }
  return positive.length === 1
    && positive[0]!.region === contract.solePositiveRegion
    && positive[0]!.numReplicas === topology.configuredReplicas;
}

function validatedProviderObservation(
  policy: PermanentStagingAppDeploymentPolicy,
  environmentId: string,
  expectedReplicaCounts: readonly number[],
  publicOrigin: string,
  scope: { readonly projectId: string; readonly environmentId: string },
  patch: { readonly environmentId: string; readonly patchEmpty: true },
  snapshot: PilotProviderSnapshot | null,
  configuredTopology: ConfiguredTopologyEvidence | null,
  collateral: ReturnType<typeof parseCollateralSnapshot>,
): ProviderObservation {
  if (!snapshot || !configuredTopology || !collateral) {
    throw new Error("provider_query_failed");
  }
  const hostname = originHostname(publicOrigin);
  const exact = scope.projectId === policy.projectId
    && scope.environmentId === environmentId
    && patch.environmentId === environmentId
    && snapshot.environmentId === environmentId
    && snapshot.serviceId === policy.target.serviceId
    && snapshot.deployment.projectId === policy.projectId
    && snapshot.deployment.environmentId === environmentId
    && snapshot.deployment.serviceId === policy.target.serviceId
    && configuredTopologyAllowed(
      policy,
      configuredTopology,
      expectedReplicaCounts,
      environmentId,
    )
    && snapshot.domains.some((domain) => domain.domain === hostname);
  if (!exact) throw new Error("provider_target_mismatch");
  return {
    tokenScopeExact: true,
    patchEmpty: patch.patchEmpty === true,
    gitAutodeployAbsent: collateral.gitAutodeployAbsent,
    collateralSha256: collateral.collateralSha256,
    configuredTopology,
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
      {
        projectId: policy.projectId,
        environmentId,
        serviceId: policy.target.serviceId,
        deploymentId,
      },
    ),
    queryCollateralSnapshot(
      fetchImpl,
      token,
      policy.projectId,
      environmentId,
    ),
  ]);
  const parsedSnapshot = parseProviderSnapshotWithConfiguredTopology(
    snapshotSource,
    policy,
    environmentId,
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
    parsedSnapshot?.snapshot ?? null,
    parsedSnapshot?.configuredTopology ?? null,
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
  response: PilotRuntimeResponse,
  candidateSha: string,
  policy: PermanentStagingAppDeploymentPolicy,
  environmentId: string,
  deploymentId: string,
  expectedSourceArchive?: ProtectedSourceArchiveIdentity,
): boolean {
  const automaticMaintenanceEnabled = environmentId === policy.target.environmentId
    ? policy.postflightContract.automaticMaintenanceEnabled
    : environmentId === TARGET_LOCKS["permanent-staging"].environmentId
      ? TARGET_LOCKS["permanent-staging"].activeAutomaticMaintenanceEnabled
      : null;
  if (automaticMaintenanceEnabled === null) return false;
  return response.route === route
    && response.deployment.sourceArchive.candidateSha === candidateSha
    && (!expectedSourceArchive || canonicalJson(response.deployment.sourceArchive)
      === canonicalJson(expectedSourceArchive))
    && response.deployment.projectIdSha256
      === railwayDeploymentIdentityIdSha256("project", policy.projectId)
    && response.deployment.environmentIdSha256
      === railwayDeploymentIdentityIdSha256("environment", environmentId)
    && response.deployment.serviceIdSha256
      === railwayDeploymentIdentityIdSha256("service", policy.target.serviceId)
    && response.deployment.deploymentIdSha256
      === railwayDeploymentIdentityIdSha256("deployment", deploymentId)
    && response.automaticMaintenance.enabled
      === automaticMaintenanceEnabled
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
  expectedSourceArchive?: ProtectedSourceArchiveIdentity,
): Promise<RuntimeObservation> {
  const parsed: PilotRuntimeResponse[] = [];
  for (const route of RUNTIME_ROUTES) {
    const response = await fetchImpl(`${origin}${route}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const source = await readBoundedResponse(response);
    const runtime = parseProtectedSourceArchiveRuntimeResponse(
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
      expectedSourceArchive,
    )) throw new Error("runtime_probe_failed");
    parsed.push(runtime);
  }
  return {
    health: parsed[0]!,
    startup: parsed[1]!,
    ready: parsed[2]!,
  };
}

async function defaultProbeRuntimeRoutesAbsentOnce(
  fetchImpl: typeof fetch,
  origin: string,
): Promise<boolean> {
  for (const route of RUNTIME_ROUTES) {
    try {
      const response = await fetchImpl(`${origin}${route}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const exactAbsentStatus = response.status === 404;
      await response.body?.cancel().catch(() => undefined);
      if (!exactAbsentStatus) return false;
    } catch {
      // A network or redirect failure cannot prove that runtime is absent.
      return false;
    }
  }
  return true;
}

async function defaultProbeRuntimeAbsent(
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
  origin: string,
): Promise<boolean> {
  for (let round = 0; round < 3; round += 1) {
    if (!await defaultProbeRuntimeRoutesAbsentOnce(fetchImpl, origin)) return false;
    if (round < 2) await sleep(5_000);
  }
  return true;
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
  probeRuntimeAbsent: async (origin) =>
    defaultProbeRuntimeAbsent(
      fetch,
      (milliseconds) => new Promise((resolve) =>
        setTimeout(resolve, milliseconds)),
      origin,
    ),
  probeRuntimeAbsentImmediately: async (origin) =>
    defaultProbeRuntimeRoutesAbsentOnce(fetch, origin),
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
  uploadIdentity?: UploadIdentity,
): boolean {
  const snapshot = observation.snapshot;
  return observation.tokenScopeExact
    && observation.patchEmpty
    && observation.gitAutodeployAbsent
    && SHA256_PATTERN.test(observation.collateralSha256)
    && (policy.target.allowedReplicaCounts as readonly number[])
      .includes(expectedReplicaCount)
    && configuredTopologyAllowed(
      policy,
      observation.configuredTopology,
      [expectedReplicaCount],
      snapshot.environmentId,
    )
    && snapshot.latestDeployment.id === snapshot.deployment.id
    && snapshot.latestDeployment.snapshotId === snapshot.deployment.snapshotId
    && snapshot.latestDeployment.status === "SUCCESS"
    && snapshot.latestDeployment.deploymentStopped === false
    && snapshot.activeDeployments.length === 1
    && snapshot.activeDeployments[0]?.id === snapshot.deployment.id
    && snapshot.activeDeployments[0]?.status === "SUCCESS"
    && snapshot.activeDeployments[0]?.deploymentStopped === false
    && typeof snapshot.deployment.imageDigest === "string"
    && /^sha256:[a-f0-9]{64}$/.test(snapshot.deployment.imageDigest)
    && (snapshot.deployment.commitHash === null
      || snapshot.deployment.commitHash === candidateSha)
    && (!uploadIdentity || (
      uploadIdentity.sourceArchive.candidateSha === candidateSha
      && (uploadIdentity.deploymentId === null
        || snapshot.deployment.id === uploadIdentity.deploymentId)
      && (snapshot.deployment.providerMessage === null
        || snapshot.deployment.providerMessage === uploadIdentity.message)
    ))
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
    && before.configuredTopology.configuredTopologySha256
      === after.configuredTopology.configuredTopologySha256
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
  uploadIdentity: UploadIdentity,
  previousDeploymentId: string | null = null,
): Promise<{ observation: ProviderObservation; runtime: RuntimeObservation } | null> {
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
      if (observation.snapshot.deployment.id !== previousDeploymentId && deploymentHealthy(
        observation,
        policy,
        candidateSha,
        preservedReplicaCount,
        uploadIdentity,
      )) {
        const runtime = await dependencies.probeRuntime(
          policy.target.publicOrigin,
          candidateSha,
          policy,
          policy.target.environmentId,
          observation.snapshot.deployment.id,
          uploadIdentity.sourceArchive,
        );
        // Even injected/runtime adapters must preserve per-upload identity.
        if (!RUNTIME_ROUTES.every((route, index) => runtimeMatches(
          route, [runtime.health, runtime.startup, runtime.ready][index]!,
          candidateSha, policy, policy.target.environmentId,
          observation.snapshot.deployment.id, uploadIdentity.sourceArchive,
        ))) throw new Error("runtime_probe_failed");
        return { observation, runtime };
      }
      if (
        observation.snapshot.deployment.id === uploadIdentity.deploymentId
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
      expectedSourceArchive,
    ) => defaultProbeRuntime(
      provisional.fetchImpl,
      origin,
      exactCandidateSha,
      exactPolicy,
      environmentId,
      deploymentId,
      expectedSourceArchive,
    )),
    probeRuntimeAbsent: overrides.probeRuntimeAbsent ?? ((origin) =>
      defaultProbeRuntimeAbsent(
        provisional.fetchImpl,
        provisional.sleep,
        origin,
      )),
    probeRuntimeAbsentImmediately:
      overrides.probeRuntimeAbsentImmediately
      ?? ((origin) => defaultProbeRuntimeRoutesAbsentOnce(
        provisional.fetchImpl,
        origin,
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
  let immediatePrewrite: ProviderObservation | null = null;
  let reconciledCandidate: ProviderObservation | null = null;
  let postflight: ProviderObservation | null = null;
  let runtime: RuntimeObservation | null = null;
  let uploadIdentity: UploadIdentity | null = null;
  let runtimeAbsentStableBeforeWrite: boolean | null = null;
  let runtimeAbsentImmediatelyBeforeWrite: boolean | null = null;
  let runtimeAbsentPostflight: boolean | null = null;
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
  let previousCandidateSha: string | null = null;
  let previousRuntime: RuntimeObservation | null = null;
  let failedStartupCorrectionProofSha256: string | null = null;
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
    previousCandidateSha = barPilotPreviousCandidateSha(dependencies.env, candidateSha);
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
      policy.sourceContract.packageLockSha256,
    );
    checks.sourceAuthorityExact = sourceAuthority.candidateSha === candidateSha
      && SHA1_PATTERN.test(sourceAuthority.treeSha)
      && SHA256_PATTERN.test(sourceAuthority.archiveSha256)
      && SHA256_PATTERN.test(sourceAuthority.snapshotManifestSha256)
      && sourceAuthority.sourceArchive.candidateSha === candidateSha
      && sourceAuthority.sourceArchive.treeSha === sourceAuthority.treeSha
      && sourceAuthority.sourceArchive.sourceArchiveSha256 === sourceAuthority.archiveSha256
      && sourceAuthority.sourceArchive.sourceIdentitySha256 === sha256(
        canonicalProtectedSourceArchiveManifest(sourceAuthority.sourceArchive))
      && path.isAbsolute(sourceAuthority.snapshotPath)
      && path.isAbsolute(sourceAuthority.deploymentPath);
    if (!checks.sourceAuthorityExact) throw new Error("source_authority_failed");
    assertBarPilotPreviousCandidateAncestor(dependencies.cwd, previousCandidateSha, candidateSha);
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
    preservedReplicaCount = preflight.configuredTopology.configuredReplicas;
    checks.configuredTopologyExact = configuredTopologyAllowed(
      policy,
      preflight.configuredTopology,
      policy.target.allowedReplicaCounts,
    );
    checks.targetPreflightExact = preflight.tokenScopeExact
      && preflight.patchEmpty
      && SHA256_PATTERN.test(preflight.collateralSha256)
      && checks.configuredTopologyExact
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
    if (policy.policyId === BAR_PILOT_STAGING_POLICY_ID) {
      const currentId = dependencies.env.PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID ?? "";
      const failedStartupRecovery = barPilotFailedStartupRecoveryRequested(dependencies.env);
      if (failedStartupRecovery) {
        failedStartupCorrectionProofSha256 = readBarPilotFailedStartupCorrectionProof(dependencies.cwd);
      }
      const exact = failedStartupRecovery
        ? barPilotFailedStartupDeploymentExact(preflight.snapshot)
          && preflight.collateralSha256 === BAR_PILOT_FAILED_STARTUP_RECOVERY.collateralSha256
        : currentId
        ? barPilotCurrentDeploymentExact(preflight.snapshot, currentId)
          && deploymentHealthy(preflight, policy, previousCandidateSha, preservedReplicaCount)
        : barPilotStoppedDeploymentExact(preflight.snapshot)
          && preflight.snapshot.deployment.commitHash === BAR_PILOT_STOPPED_SOURCE_SHA;
      if (!exact) throw new Error("target_preflight_failed");
      if (currentId) {
        const currentRuntime = await dependencies.probeRuntime(
          policy.target.publicOrigin, previousCandidateSha, policy,
          policy.target.environmentId, currentId,
        );
        for (const [index, route] of RUNTIME_ROUTES.entries()) {
          if (!runtimeMatches(
            route, [currentRuntime.health, currentRuntime.startup, currentRuntime.ready][index]!,
            previousCandidateSha, policy, policy.target.environmentId, currentId,
            currentRuntime.health.deployment.sourceArchive,
          )) throw new Error("target_preflight_failed");
        }
        previousRuntime = currentRuntime;
      }
      // Applying skipDeploys configuration needs a new process even when source
      // is unchanged. The pilot always uploads the exact archive once.
      preflightAlreadyCandidate = false;
    }
    if (preflightAlreadyCandidate && !deploymentHealthy(
      preflight,
      policy,
      candidateSha,
      preservedReplicaCount,
    )) {
      throw new Error("candidate_preexisting_not_healthy");
    }

    if (!isFencedDeploymentPolicy(policy)) {
      checks.fencedRuntimeAbsentBeforeWrite = true;
      checks.fencedRuntimeAbsentPostflight = true;
    }

    const intent = {
      schemaVersion: "pintpath-railway-application-deployment-intent/v3",
      operation: PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION,
      target: policy.target.name,
      candidateSha,
      treeSha: sourceAuthority.treeSha,
      sourceArchiveSha256: sourceAuthority.archiveSha256,
      sourceSnapshotManifestSha256: sourceAuthority.snapshotManifestSha256,
      sourceArchive: sourceAuthority.sourceArchive,
      previousDeploymentIdSha256: railwayDeploymentIdentityIdSha256(
        "deployment",
        preflight.snapshot.deployment.id,
      ),
      ...(previousRuntime ? { healthyCurrentSource: {
        candidateSha: previousCandidateSha,
        ancestorOfCandidate: true,
        sourceArchive: previousRuntime.health.deployment.sourceArchive,
        snapshotId: preflight.snapshot.deployment.snapshotId,
        runtimeResponseSha256s: {
          health: previousRuntime.health.responseSha256,
          startup: previousRuntime.startup.responseSha256,
          ready: previousRuntime.ready.responseSha256,
        },
      } } : {}),
      ...(failedStartupCorrectionProofSha256 ? { failedStartupRecovery: {
        previousRunId: BAR_PILOT_FAILED_STARTUP_RECOVERY.workflowRunId,
        previousIntentSha256: BAR_PILOT_FAILED_STARTUP_RECOVERY.intentSha256,
        previousSourceIdentitySha256: BAR_PILOT_FAILED_STARTUP_RECOVERY.sourceIdentitySha256,
        previousSnapshotId: BAR_PILOT_FAILED_STARTUP_RECOVERY.snapshotId,
        correctionProofSha256: failedStartupCorrectionProofSha256,
        previousOutcome: "FAILED",
        automaticRetryAllowed: false,
      } } : {}),
      workerFencePrerequisite,
      preservedReplicaCount,
      legacyReplicaCountBefore: preflight.snapshot.numReplicas,
      configuredTopology: {
        authoritativeSource:
          "environment.config(decryptVariables:false)",
        before: preflight.configuredTopology,
        immediatelyBeforeWriteRequired: true,
        expectedImmediatelyBeforeWriteSha256:
          preflight.configuredTopology.configuredTopologySha256,
      },
      runtimeAbsence: {
        required: isFencedDeploymentPolicy(policy),
        immediatelyBeforeWriteMustBeTrue: isFencedDeploymentPolicy(policy),
      },
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

    const message = `pintpath:${policy.target.name}:${candidateSha}:${intentSha256}`;
    uploadIdentity = {
      deploymentId: null,
      message,
      sourceArchive: sourceAuthority.sourceArchive,
    };
    cliAuthority.assertExact();
    if (isFencedDeploymentPolicy(policy)) {
      runtimeAbsentStableBeforeWrite =
        await dependencies.probeRuntimeAbsent(policy.target.publicOrigin);
      if (runtimeAbsentStableBeforeWrite !== true) {
        throw new Error("fenced_runtime_present");
      }
    }
    immediatePrewrite = await dependencies.queryTarget(
      policy,
      policy.target.environmentId,
      [preservedReplicaCount],
      policy.target.publicOrigin,
      targetToken,
    );
    checks.immediatePrewriteExact =
      immediatePrewrite.configuredTopology.configuredReplicas
        === preservedReplicaCount
      && immediatePrewrite.configuredTopology.configuredTopologySha256
        === preflight.configuredTopology.configuredTopologySha256
      && collateralUnchanged(preflight, immediatePrewrite)
      && providerDeploymentUnchanged(preflight, immediatePrewrite);
    if (!checks.immediatePrewriteExact) {
      throw new Error("immediate_prewrite_failed");
    }
    if (isFencedDeploymentPolicy(policy)) {
      runtimeAbsentImmediatelyBeforeWrite =
        await dependencies.probeRuntimeAbsentImmediately(
          policy.target.publicOrigin,
        );
      checks.fencedRuntimeAbsentBeforeWrite =
        runtimeAbsentStableBeforeWrite === true
        && runtimeAbsentImmediatelyBeforeWrite === true;
      if (!checks.fencedRuntimeAbsentBeforeWrite) {
        throw new Error("fenced_runtime_present");
      }
    }
    checks.sourceReasserted = false;
    sourceAuthority.reassert();
    checks.sourceReasserted = true;
    cliAuthority.assertExact();
    assertBarPilotPreviousCandidateAncestor(dependencies.cwd, previousCandidateSha, candidateSha);

    if (!preflightAlreadyCandidate) {
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
      const uploadedDeploymentId = parseUploadDeploymentId(writeResult.stdout);
      if (uploadedDeploymentId === preflight.snapshot.deployment.id) {
        throw new Error("reconciliation_failed");
      }
      uploadIdentity = { ...uploadIdentity, deploymentId: uploadedDeploymentId };
      acknowledgement = writeResult.code === 0 && !writeResult.timedOut && uploadedDeploymentId
        ? "received"
        : "missing_or_failed";
    }
    checks.writeAttemptedAtMostOnce = writeAttempts <= 1;
    const reconciled = await pollForCandidate(
        policy,
        targetToken,
        candidateSha,
        preservedReplicaCount,
        dependencies,
        uploadIdentity,
        policy.policyId === BAR_PILOT_STAGING_POLICY_ID ? preflight.snapshot.deployment.id : null,
      );
    reconciledCandidate = reconciled?.observation ?? null;
    runtime = reconciled?.runtime ?? null;
    if (reconciledCandidate) {
      checks.deploymentExact = deploymentHealthy(
        reconciledCandidate,
        policy,
        candidateSha,
        preservedReplicaCount,
        uploadIdentity,
      );
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
            uploadIdentity ?? undefined,
          );
          checks.topologyPreserved =
            postflight.configuredTopology.configuredReplicas
              === preflight.configuredTopology.configuredReplicas
            && postflight.configuredTopology.configuredTopologySha256
              === preflight.configuredTopology.configuredTopologySha256;
          checks.collateralStateUnchanged = collateralUnchanged(
            preflight,
            postflight,
          );
          if (isFencedDeploymentPolicy(policy)) {
            runtimeAbsentPostflight = await dependencies.probeRuntimeAbsent(
              policy.target.publicOrigin,
            );
            checks.fencedRuntimeAbsentPostflight =
              runtimeAbsentPostflight === true;
          }
          checks.targetPostflightExact = checks.deploymentExact
            && checks.topologyPreserved
            && checks.collateralStateUnchanged
            && checks.fencedRuntimeAbsentPostflight
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
    checks.configuredTopologyExact,
    checks.immediatePrewriteExact,
    checks.fencedRuntimeAbsentBeforeWrite,
    checks.fencedRuntimeAbsentPostflight,
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
      before: preflight?.configuredTopology?.configuredReplicas ?? null,
      after: postflight?.configuredTopology?.configuredReplicas ?? null,
    },
    legacyReplicaCounts: {
      before: preflight?.snapshot.numReplicas ?? null,
      immediatelyBeforeWrite:
        immediatePrewrite?.snapshot.numReplicas ?? null,
      after: postflight?.snapshot.numReplicas ?? null,
    },
    configuredTopology: {
      authoritativeSource: "environment.config(decryptVariables:false)",
      before: preflight?.configuredTopology ?? null,
      immediatelyBeforeWrite:
        immediatePrewrite?.configuredTopology ?? null,
      after: postflight?.configuredTopology ?? null,
    },
    runtimeAbsence: {
      required: policy ? isFencedDeploymentPolicy(policy) : false,
      immediatelyBeforeWrite: runtimeAbsentImmediatelyBeforeWrite,
      postflight: runtimeAbsentPostflight,
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
  RAILWAY_APPLICATION_DEPLOYMENT_SNAPSHOT_QUERY,
  TARGET_LOCKS,
  configuredTopologyAllowed,
  configuredTopologyEvidence,
  costPolicyExact,
  defaultProbeRuntime,
  defaultQueryTarget,
  defaultProbeRuntimeAbsent,
  deploymentHealthy,
  holdSnapshotRootDirectory,
  parseArguments,
  parseCollateralSnapshot,
  parsePilotProviderSnapshot,
  parseProviderSnapshotWithConfiguredTopology,
  materializeSourceArchiveIdentity,
  queryCollateralSnapshot,
  readSourceArchiveSha256,
  parseDiscoveryDeploymentId,
  parseUploadDeploymentId,
  policyMatchesLock,
  providerDeploymentUnchanged,
  runtimeMatches,
  safeFailureCode,
  snapshotManifestSha256,
  validateCli,
  validatedProviderObservation,
});
