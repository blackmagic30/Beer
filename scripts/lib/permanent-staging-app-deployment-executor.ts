export const PERMANENT_STAGING_APP_DEPLOYMENT_POLICY_SCHEMA =
  "pintpath-permanent-staging-app-deployment-policy/v1" as const;
export const PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA =
  "pintpath-permanent-staging-app-deployment-executor/v1" as const;
export const PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION =
  "pintpath-permanent-staging-app-source-upload" as const;
export const PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE =
  "HARD_DISABLED_REVIEW_REQUIRED" as const;

const REQUIRED_RUNTIME_ROUTES = Object.freeze([
  "/health",
  "/startup",
  "/ready",
] as const);

export const PERMANENT_STAGING_APP_DEPLOYMENT_LOCK = Object.freeze({
  policyId: PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION,
  activationState: PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE,
  projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  productionEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
  stagingEnvironmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
  railwayCli: Object.freeze({
    version: "5.32.0",
    absolutePath: "/opt/homebrew/Cellar/railway/5.32.0/bin/railway",
    sha256:
      "26e3e0fd2b59fd9f7b1e891cbc8f3ca9b0266556545f00ba4db3ce754fbc10d1",
  }),
  sourceContract: Object.freeze({
    candidateBinding: "exact-clean-committed-head",
    privateSnapshotRequired: true,
    sourceManifestRequired: true,
    sourceManifestAlgorithm:
      "sha256-json-depth-first-bytewise-siblings-path-type-mode-size-content-v1",
    railwayConfigPath: "/railway.toml",
    railwayConfigSha256:
      "85dc659ebec2e0132092d917505d71678e92b8441b54bcefc80c6a082e3b967b",
    packageLockSha256:
      "61f07b4a529dfed6624394719327b03032d9ad34bfe162f43131b6bdfcfc60ef",
  }),
  writeContract: Object.freeze({
    mode: "single-source-upload",
    transportImplemented: false,
    providerNetworkAllowed: false,
    maximumWriteAttempts: 1,
    sequentialNotAtomic: true,
    externalMutationFreezeRequired: true,
    autoDeployAllowed: false,
    fromSourceAllowed: false,
    redeployAllowed: false,
    nativeRollbackAllowed: false,
    scaleAllowed: false,
    domainMutationAllowed: false,
    routeMutationAllowed: false,
    pitrMutationAllowed: false,
    deleteAllowed: false,
    variableMutationAllowed: false,
    volumeMutationAllowed: false,
    resourceCreationAllowed: false,
  }),
  postflightContract: Object.freeze({
    expectedReplicaCount: 1,
    expectedDeploymentStatus: "SUCCESS",
    expectedDeploymentStopped: false,
    deploymentPatchAllowed: false,
    requiredRuntimeRoutes: REQUIRED_RUNTIME_ROUTES,
    applicationAttestationPolicySha256:
      "b056b175f981d7b51a9590943e209e82a0dfcbea650de7a4cb5ecf37a67bbdd1",
  }),
  spendContract: Object.freeze({
    reviewedRecurringStagingMonthlyUsd: 46.8,
    maximumStagingMonthlyUsd: 50,
    additionalUnapprovedSpendAllowed: false,
  }),
} as const);

export interface PermanentStagingAppDeploymentPolicy {
  readonly schemaVersion: typeof PERMANENT_STAGING_APP_DEPLOYMENT_POLICY_SCHEMA;
  readonly policyId: typeof PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION;
  readonly activationState:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE;
  readonly projectId: typeof PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.projectId;
  readonly productionEnvironmentId:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.productionEnvironmentId;
  readonly stagingEnvironmentId:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.stagingEnvironmentId;
  readonly serviceId: typeof PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.serviceId;
  readonly railwayCli: typeof PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.railwayCli;
  readonly sourceContract:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.sourceContract;
  readonly writeContract:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.writeContract;
  readonly postflightContract:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.postflightContract;
  readonly spendContract:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.spendContract;
}

export interface PermanentStagingAppDeploymentExecutorChecks {
  readonly frameworkEnabled: false;
  readonly policyExact: false;
  readonly authorizationExact: false;
  readonly localSourceAuthorityExact: false;
  readonly boundaryPreflightExact: false;
  readonly targetPreflightExact: false;
  readonly durableIntentExact: false;
  readonly localAuthorityReasserted: false;
  readonly boundaryReasserted: false;
  readonly writeAttempted: false;
  readonly acknowledgementExact: false;
  readonly postflightAttempted: false;
  readonly boundaryPostflightExact: false;
  readonly targetPostflightExact: false;
  readonly runtimeAttestationExact: false;
  readonly collateralStateUnchanged: false;
  readonly terminalEvidenceExact: false;
  readonly finalizationExact: false;
}

export interface PermanentStagingAppDeploymentExecutorReceipt {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA;
  readonly operation: typeof PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION;
  readonly executorState:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE;
  readonly mode: "framework-disabled";
  readonly outcome: "blocked";
  readonly candidateSha: null;
  readonly previousDeploymentIdSha256: null;
  readonly deploymentIdSha256: null;
  readonly intentSha256: null;
  readonly attestationFileSha256: null;
  readonly terminalEvidenceSha256: null;
  readonly checks: PermanentStagingAppDeploymentExecutorChecks;
}

function buildCanonicalPolicy(): PermanentStagingAppDeploymentPolicy {
  const lock = PERMANENT_STAGING_APP_DEPLOYMENT_LOCK;
  return Object.freeze({
    schemaVersion: PERMANENT_STAGING_APP_DEPLOYMENT_POLICY_SCHEMA,
    policyId: PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION,
    activationState: PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE,
    projectId: lock.projectId,
    productionEnvironmentId: lock.productionEnvironmentId,
    stagingEnvironmentId: lock.stagingEnvironmentId,
    serviceId: lock.serviceId,
    railwayCli: lock.railwayCli,
    sourceContract: lock.sourceContract,
    writeContract: lock.writeContract,
    postflightContract: lock.postflightContract,
    spendContract: lock.spendContract,
  });
}

export const PERMANENT_STAGING_APP_DEPLOYMENT_CANONICAL_POLICY_SOURCE =
  `${JSON.stringify(buildCanonicalPolicy(), null, 2)}\n`;

export function parsePermanentStagingAppDeploymentPolicy(
  source: unknown,
): PermanentStagingAppDeploymentPolicy | null {
  return typeof source === "string"
    && source === PERMANENT_STAGING_APP_DEPLOYMENT_CANONICAL_POLICY_SOURCE
    ? buildCanonicalPolicy()
    : null;
}

const FIXED_DISABLED_CHECKS = Object.freeze({
  frameworkEnabled: false,
  policyExact: false,
  authorizationExact: false,
  localSourceAuthorityExact: false,
  boundaryPreflightExact: false,
  targetPreflightExact: false,
  durableIntentExact: false,
  localAuthorityReasserted: false,
  boundaryReasserted: false,
  writeAttempted: false,
  acknowledgementExact: false,
  postflightAttempted: false,
  boundaryPostflightExact: false,
  targetPostflightExact: false,
  runtimeAttestationExact: false,
  collateralStateUnchanged: false,
  terminalEvidenceExact: false,
  finalizationExact: false,
} as const satisfies PermanentStagingAppDeploymentExecutorChecks);

export const PERMANENT_STAGING_APP_DEPLOYMENT_BLOCKED_RECEIPT = Object.freeze({
  schemaVersion: PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA,
  operation: PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION,
  executorState: PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE,
  mode: "framework-disabled",
  outcome: "blocked",
  candidateSha: null,
  previousDeploymentIdSha256: null,
  deploymentIdSha256: null,
  intentSha256: null,
  attestationFileSha256: null,
  terminalEvidenceSha256: null,
  checks: FIXED_DISABLED_CHECKS,
} as const satisfies PermanentStagingAppDeploymentExecutorReceipt);

const FIXED_DISABLED_RECEIPT_LINE =
  `${JSON.stringify(PERMANENT_STAGING_APP_DEPLOYMENT_BLOCKED_RECEIPT)}\n`;

export async function runPermanentStagingAppDeploymentExecutor(): Promise<1> {
  process.stdout.write(FIXED_DISABLED_RECEIPT_LINE);
  return 1;
}
