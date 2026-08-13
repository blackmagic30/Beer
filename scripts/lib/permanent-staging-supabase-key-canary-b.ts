import {
  arrayEvery,
  arrayMap,
  deepFreeze,
  denseArray,
  exactDataRecord,
  isExactUuid,
  isLowercaseHex,
  isSafeInteger,
  parseCanonicalJson,
  regexpTest,
  uniqueStrings,
} from "./permanent-staging-supabase-containment-primitives.js";

export const PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_OBSERVATION_SCHEMA =
  "pintpath-permanent-staging-supabase-key-canary-b-observation/v1" as const;

export const PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_POLICY = deepFreeze({
  schemaVersion: "pintpath-permanent-staging-supabase-key-canary-b-policy/v1",
  policyId: "permanent-staging-supabase-replacement-key-canary-b",
  activationState: "HARD_DISABLED_REVIEW_REQUIRED",
  railwayTarget: {
    projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
    environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    applicationServiceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
    canaryServiceId: "34a312cd-0920-4a7e-90db-8561c1e0746b",
    railwayConfigPath: "/railway.supabase-key-canary.toml",
  },
  lifecycle: {
    startCommand: "node dist/scripts/staging-supabase-key-canary.js",
    restartPolicyType: "NEVER",
    publicDomains: [],
    tcpProxyPorts: [],
  },
  sourceReview: {
    entrypointPath: "scripts/staging-supabase-key-canary.ts",
    gitCommitSha: null,
    entrypointSha256: null,
    railwayConfigSha256: null,
    imageDigest: null,
    reviewRequired: true,
  },
  requiredReferences: [
    {
      name: "SUPABASE_URL",
      sourceServiceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
      sourceVariableName: "SUPABASE_URL",
    },
    {
      name: "SUPABASE_ANON_KEY",
      sourceServiceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
      sourceVariableName: "SUPABASE_ANON_KEY",
    },
    {
      name: "SUPABASE_SERVICE_ROLE_KEY",
      sourceServiceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
      sourceVariableName: "SUPABASE_SERVICE_ROLE_KEY",
    },
  ],
  readOnlyChecks: [
    "staging-auth-settings",
    "staging-auth-admin-list-limit-one",
    "staging-private-storage-bucket",
  ],
  reviewLocks: {
    deploymentId: null,
    gitCommitSha: null,
    entrypointSha256: null,
    railwayConfigSha256: null,
    imageDigest: null,
  },
} as const);

export const PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_CANONICAL_POLICY_SOURCE =
  `${JSON.stringify(PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_POLICY, null, 2)}\n`;

interface CanaryReferenceObservation {
  readonly name: string;
  readonly sourceServiceId: string;
  readonly sourceVariableName: string;
}

export interface PermanentStagingSupabaseKeyCanaryBObservation {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_OBSERVATION_SCHEMA;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly railwayConfigPath: string;
  readonly deploymentId: string;
  readonly lifecycle: {
    readonly startCommand: string;
    readonly restartPolicyType: string;
  };
  readonly network: {
    readonly publicDomains: readonly string[];
    readonly tcpProxyPorts: readonly number[];
  };
  readonly source: {
    readonly entrypointPath: string;
    readonly gitCommitSha: string;
    readonly entrypointSha256: string;
    readonly railwayConfigSha256: string;
    readonly imageDigest: string;
  };
  readonly references: readonly CanaryReferenceObservation[];
  readonly checks: {
    readonly stagingAuthSettings: boolean;
    readonly stagingAuthAdminListLimitOne: boolean;
    readonly stagingPrivateStorageBucket: boolean;
  };
}

function validReference(value: unknown): value is CanaryReferenceObservation {
  return exactDataRecord(value, ["name", "sourceServiceId", "sourceVariableName"])
    && typeof value.name === "string"
    && regexpTest(/^[A-Z][A-Z0-9_]{1,127}$/, value.name)
    && isExactUuid(value.sourceServiceId)
    && typeof value.sourceVariableName === "string"
    && regexpTest(/^[A-Z][A-Z0-9_]{1,127}$/, value.sourceVariableName);
}

export function parsePermanentStagingSupabaseKeyCanaryBPolicy(
  source: unknown,
): typeof PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_POLICY | null {
  return source === PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_CANONICAL_POLICY_SOURCE
    ? PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_POLICY
    : null;
}

export function parsePermanentStagingSupabaseKeyCanaryBObservation(
  source: unknown,
): PermanentStagingSupabaseKeyCanaryBObservation | null {
  const value = parseCanonicalJson(source);
  if (
    !exactDataRecord(value, [
      "schemaVersion",
      "projectId",
      "environmentId",
      "serviceId",
      "railwayConfigPath",
      "deploymentId",
      "lifecycle",
      "network",
      "source",
      "references",
      "checks",
    ])
    || value.schemaVersion
      !== PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_OBSERVATION_SCHEMA
    || !isExactUuid(value.projectId)
    || !isExactUuid(value.environmentId)
    || !isExactUuid(value.serviceId)
    || typeof value.railwayConfigPath !== "string"
    || !isExactUuid(value.deploymentId)
    || !exactDataRecord(value.lifecycle, ["startCommand", "restartPolicyType"])
    || typeof value.lifecycle.startCommand !== "string"
    || typeof value.lifecycle.restartPolicyType !== "string"
    || !exactDataRecord(value.network, ["publicDomains", "tcpProxyPorts"])
    || !denseArray(value.network.publicDomains, 16)
    || !arrayEvery(value.network.publicDomains, (domain) =>
      typeof domain === "string" && domain.length >= 1 && domain.length <= 253)
    || !denseArray(value.network.tcpProxyPorts, 16)
    || !arrayEvery(value.network.tcpProxyPorts, (port) =>
      isSafeInteger(port) && port >= 1 && port <= 65_535)
    || !exactDataRecord(value.source, [
      "entrypointPath",
      "gitCommitSha",
      "entrypointSha256",
      "railwayConfigSha256",
      "imageDigest",
    ])
    || typeof value.source.entrypointPath !== "string"
    || !isLowercaseHex(value.source.gitCommitSha, 40)
    || !isLowercaseHex(value.source.entrypointSha256, 64)
    || !isLowercaseHex(value.source.railwayConfigSha256, 64)
    || typeof value.source.imageDigest !== "string"
    || !regexpTest(/^sha256:[0-9a-f]{64}$/, value.source.imageDigest)
    || !denseArray(value.references, 32)
    || !arrayEvery(value.references, validReference)
    || !uniqueStrings(arrayMap(value.references, (reference) => reference.name))
    || !exactDataRecord(value.checks, [
      "stagingAuthSettings",
      "stagingAuthAdminListLimitOne",
      "stagingPrivateStorageBucket",
    ])
    || typeof value.checks.stagingAuthSettings !== "boolean"
    || typeof value.checks.stagingAuthAdminListLimitOne !== "boolean"
    || typeof value.checks.stagingPrivateStorageBucket !== "boolean"
  ) return null;
  return deepFreeze(value as unknown as PermanentStagingSupabaseKeyCanaryBObservation);
}

export interface PermanentStagingSupabaseKeyCanaryBEvaluation {
  readonly outcome: "passed" | "blocked-review-required" | "failed";
  readonly targetExact: boolean;
  readonly lifecycleExact: boolean;
  readonly noIngress: boolean;
  readonly sourceExact: boolean;
  readonly referencesExact: boolean;
  readonly readOnlyChecksPassed: boolean;
  readonly policyActivated: boolean;
  readonly reviewLocksComplete: boolean;
}

export function evaluatePermanentStagingSupabaseKeyCanaryB(
  observation: PermanentStagingSupabaseKeyCanaryBObservation,
): PermanentStagingSupabaseKeyCanaryBEvaluation {
  const policy = PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_POLICY;
  const targetExact = observation.projectId === policy.railwayTarget.projectId
    && observation.environmentId === policy.railwayTarget.environmentId
    && observation.serviceId === policy.railwayTarget.canaryServiceId
    && observation.railwayConfigPath === policy.railwayTarget.railwayConfigPath;
  const lifecycleExact = observation.lifecycle.startCommand
      === policy.lifecycle.startCommand
    && observation.lifecycle.restartPolicyType === policy.lifecycle.restartPolicyType;
  const noIngress = observation.network.publicDomains.length === 0
    && observation.network.tcpProxyPorts.length === 0;
  const deploymentLock = policy.reviewLocks.deploymentId as unknown;
  const commitLock = policy.reviewLocks.gitCommitSha as unknown;
  const entrypointLock = policy.reviewLocks.entrypointSha256 as unknown;
  const configLock = policy.reviewLocks.railwayConfigSha256 as unknown;
  const imageLock = policy.reviewLocks.imageDigest as unknown;
  const reviewLocksComplete = typeof deploymentLock === "string"
    && deploymentLock.length > 0
    && typeof commitLock === "string"
    && commitLock.length > 0
    && typeof entrypointLock === "string"
    && entrypointLock.length > 0
    && typeof configLock === "string"
    && configLock.length > 0
    && typeof imageLock === "string"
    && imageLock.length > 0;
  const sourceExact = reviewLocksComplete
    && observation.source.entrypointPath === policy.sourceReview.entrypointPath
    && observation.deploymentId === policy.reviewLocks.deploymentId
    && observation.source.gitCommitSha === policy.reviewLocks.gitCommitSha
    && observation.source.entrypointSha256 === policy.reviewLocks.entrypointSha256
    && observation.source.railwayConfigSha256
      === policy.reviewLocks.railwayConfigSha256
    && observation.source.imageDigest === policy.reviewLocks.imageDigest;
  const referencesExact = observation.references.length
      === policy.requiredReferences.length
    && arrayEvery(observation.references, (reference, index) => {
      const expected = policy.requiredReferences[index];
      return expected !== undefined
        && reference.name === expected.name
        && reference.sourceServiceId === expected.sourceServiceId
        && reference.sourceVariableName === expected.sourceVariableName;
    });
  const readOnlyChecksPassed = observation.checks.stagingAuthSettings
    && observation.checks.stagingAuthAdminListLimitOne
    && observation.checks.stagingPrivateStorageBucket;
  const policyActivated = policy.activationState === ("ENABLED_REVIEWED" as string);
  const structuralPassed = targetExact && lifecycleExact && noIngress
    && sourceExact && referencesExact && readOnlyChecksPassed;
  return deepFreeze({
    outcome: structuralPassed && policyActivated
      ? "passed"
      : !policyActivated || !reviewLocksComplete
        ? "blocked-review-required"
        : "failed",
    targetExact,
    lifecycleExact,
    noIngress,
    sourceExact,
    referencesExact,
    readOnlyChecksPassed,
    policyActivated,
    reviewLocksComplete,
  });
}
