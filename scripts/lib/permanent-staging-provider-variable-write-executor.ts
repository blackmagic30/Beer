export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_POLICY_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-policy/v2" as const;
export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_SCHEMA =
  "pintpath-permanent-staging-provider-variable-executor/v1" as const;
export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATION =
  "permanent-staging-provider-variable-single-write" as const;
export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_STATE =
  "HARD_DISABLED_REVIEW_REQUIRED" as const;

export const PERMANENT_STAGING_PROVIDER_VARIABLE_NAMES = Object.freeze([
  "GOOGLE_MAPS_API_KEY",
  "GOOGLE_MAPS_MAP_ID",
  "GOOGLE_PLACES_API_KEY",
  "OPENAI_API_KEY",
] as const);

export type PermanentStagingProviderVariableName =
  (typeof PERMANENT_STAGING_PROVIDER_VARIABLE_NAMES)[number];

const EMPTY_REFERENCES = Object.freeze([] as const);

function operation(
  operationId: string,
  variableName: PermanentStagingProviderVariableName,
  evidenceSlug: string,
) {
  return Object.freeze({
    operationId,
    variableName,
    intentLeaf:
      `pintpath-permanent-staging-provider-variable-${evidenceSlug}-intent.json`,
    terminalEvidenceLeaf:
      `pintpath-permanent-staging-provider-variable-${evidenceSlug}-terminal-evidence.json`,
  });
}

export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS =
  Object.freeze([
    operation(
      "permanent-staging-provider-variable-create/google-maps-api-key",
      "GOOGLE_MAPS_API_KEY",
      "google-maps-api-key",
    ),
    operation(
      "permanent-staging-provider-variable-create/google-maps-map-id",
      "GOOGLE_MAPS_MAP_ID",
      "google-maps-map-id",
    ),
    operation(
      "permanent-staging-provider-variable-create/google-places-api-key",
      "GOOGLE_PLACES_API_KEY",
      "google-places-api-key",
    ),
    operation(
      "permanent-staging-provider-variable-create/openai-api-key",
      "OPENAI_API_KEY",
      "openai-api-key",
    ),
  ] as const);

export type PermanentStagingProviderVariableWriteOperation =
  (typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS)[number];

export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK = Object.freeze({
  policyId: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATION,
  activationState: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_STATE,
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
  writeContract: Object.freeze({
    mode: "create-only",
    stdinOnly: true,
    skipDeploys: true,
    jsonOutput: false,
    maximumValueBytes: 4_096,
    expectedBefore: "absent",
    expectedIsSealed: false,
    expectedReferences: EMPTY_REFERENCES,
    sequentialNotAtomic: true,
    externalMutationFreezeRequired: true,
    stdoutHandling: "discard",
    stderrHandling: "discard",
    deploymentDeltaAllowed: false,
  }),
} as const);

export interface PermanentStagingProviderVariableWritePolicy {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_POLICY_SCHEMA;
  readonly policyId:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATION;
  readonly activationState:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_STATE;
  readonly projectId:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.projectId;
  readonly productionEnvironmentId:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.productionEnvironmentId;
  readonly stagingEnvironmentId:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.stagingEnvironmentId;
  readonly serviceId:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.serviceId;
  readonly operations:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS;
  readonly railwayCli: {
    readonly version:
      typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.railwayCli.version;
    readonly absolutePath:
      typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.railwayCli.absolutePath;
    readonly sha256:
      typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.railwayCli.sha256;
  };
  readonly writeContract: {
    readonly mode: "create-only";
    readonly stdinOnly: true;
    readonly skipDeploys: true;
    readonly jsonOutput: false;
    readonly maximumValueBytes: 4096;
    readonly expectedBefore: "absent";
    readonly expectedIsSealed: false;
    readonly expectedReferences: readonly [];
    readonly sequentialNotAtomic: true;
    readonly externalMutationFreezeRequired: true;
    readonly stdoutHandling: "discard";
    readonly stderrHandling: "discard";
    readonly deploymentDeltaAllowed: false;
  };
}

export interface PermanentStagingProviderVariableWriteExecutorChecks {
  readonly frameworkEnabled: false;
  readonly policyExact: false;
  readonly inputHeldAndBound: false;
  readonly localAuthorityExact: false;
  readonly boundaryPreflightExact: false;
  readonly targetPreflightExact: false;
  readonly durableIntentExact: false;
  readonly boundaryReasserted: false;
  readonly writeAttempted: false;
  readonly acknowledgementExact: false;
  readonly postflightAttempted: false;
  readonly boundaryPostflightExact: false;
  readonly targetPostflightExact: false;
  readonly deploymentUnchanged: false;
  readonly terminalEvidenceExact: false;
}

export interface PermanentStagingProviderVariableWriteExecutorReceipt {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_SCHEMA;
  readonly operation:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATION;
  readonly executorState:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_STATE;
  readonly mode: "framework-disabled";
  readonly outcome: "blocked";
  readonly variableName: null;
  readonly intentSha256: null;
  readonly terminalEvidenceSha256: null;
  readonly checks: PermanentStagingProviderVariableWriteExecutorChecks;
}

function buildCanonicalPolicy(): PermanentStagingProviderVariableWritePolicy {
  const lock = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK;
  return Object.freeze({
    schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_POLICY_SCHEMA,
    policyId: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATION,
    activationState: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_STATE,
    projectId: lock.projectId,
    productionEnvironmentId: lock.productionEnvironmentId,
    stagingEnvironmentId: lock.stagingEnvironmentId,
    serviceId: lock.serviceId,
    operations: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS,
    railwayCli: lock.railwayCli,
    writeContract: lock.writeContract,
  });
}

export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE =
  `${JSON.stringify(buildCanonicalPolicy(), null, 2)}\n`;

export function parsePermanentStagingProviderVariableWritePolicy(
  source: unknown,
): PermanentStagingProviderVariableWritePolicy | null {
  return typeof source === "string"
    && source
      === PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE
    ? buildCanonicalPolicy()
    : null;
}

const FIXED_DISABLED_CHECKS = Object.freeze({
  frameworkEnabled: false,
  policyExact: false,
  inputHeldAndBound: false,
  localAuthorityExact: false,
  boundaryPreflightExact: false,
  targetPreflightExact: false,
  durableIntentExact: false,
  boundaryReasserted: false,
  writeAttempted: false,
  acknowledgementExact: false,
  postflightAttempted: false,
  boundaryPostflightExact: false,
  targetPostflightExact: false,
  deploymentUnchanged: false,
  terminalEvidenceExact: false,
} as const satisfies PermanentStagingProviderVariableWriteExecutorChecks);

export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_BLOCKED_RECEIPT =
  Object.freeze({
    schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_SCHEMA,
    operation: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATION,
    executorState: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_STATE,
    mode: "framework-disabled",
    outcome: "blocked",
    variableName: null,
    intentSha256: null,
    terminalEvidenceSha256: null,
    checks: FIXED_DISABLED_CHECKS,
  } as const satisfies PermanentStagingProviderVariableWriteExecutorReceipt);

const FIXED_DISABLED_RECEIPT_LINE =
  `${JSON.stringify(PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_BLOCKED_RECEIPT)}\n`;

export async function runPermanentStagingProviderVariableWriteExecutor():
Promise<1> {
  process.stdout.write(FIXED_DISABLED_RECEIPT_LINE);
  return 1;
}
