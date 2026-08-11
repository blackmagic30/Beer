import { createHash } from "node:crypto";

import {
  PERMANENT_STAGING_SUPABASE_KEY_NAMES,
  isExactPermanentStagingSupabaseAbortSignal,
  isPermanentStagingSupabaseKeyCustody,
  isPermanentStagingSupabaseSignalAborted,
  type PermanentStagingSupabaseKeyBuffers,
  type PermanentStagingSupabaseKeyCustody,
} from "./permanent-staging-supabase-key-input.js";
import {
  arrayEvery,
  arrayFilter,
  arrayFind,
  arrayIncludes,
  arrayMap,
  arraySome,
  canonicalJson,
  deepFreeze,
  denseArray,
  exactDataRecord,
  freezeExact,
  isExactUuid,
  parseCanonicalJson,
  regexpTest,
  uniqueStrings,
} from "./permanent-staging-supabase-containment-primitives.js";

export const PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_STATE =
  "HARD_DISABLED_REVIEW_REQUIRED" as const;
export const PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_OBSERVATION_SCHEMA =
  "pintpath-permanent-staging-supabase-key-replacement-observation/v1" as const;
export const PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_ACK_SCHEMA =
  "pintpath-permanent-staging-supabase-key-replacement-acknowledgement/v1" as const;
export const PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_INTENT_SCHEMA =
  "pintpath-permanent-staging-supabase-key-replacement-intent/v1" as const;
export const PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_TERMINAL_SCHEMA =
  "pintpath-permanent-staging-supabase-key-replacement-terminal/v1" as const;

export const PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY = deepFreeze({
  schemaVersion: "pintpath-permanent-staging-supabase-key-replacement-policy/v1",
  policyId: "permanent-staging-supabase-three-key-replacement",
  activationState: PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_STATE,
  railwayTarget: {
    projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
    environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    applicationServiceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
    canaryServiceId: "34a312cd-0920-4a7e-90db-8561c1e0746b",
  },
  keys: [
    {
      name: "SUPABASE_ANON_KEY",
      format: "sb_publishable",
      expectedSealed: false,
      targetServiceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
      allowedReferenceServiceId: "34a312cd-0920-4a7e-90db-8561c1e0746b",
    },
    {
      name: "SUPABASE_SERVICE_ROLE_KEY",
      format: "sb_secret",
      expectedSealed: true,
      targetServiceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
      allowedReferenceServiceId: "34a312cd-0920-4a7e-90db-8561c1e0746b",
    },
    {
      name: "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
      format: "sb_secret",
      expectedSealed: true,
      targetServiceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
      allowedReferenceServiceId: "34a312cd-0920-4a7e-90db-8561c1e0746b",
    },
  ],
  mutation: {
    operationName: "variableCollectionUpsert",
    mergeCardinality: "exactly-one-all-or-nothing",
    skipDeploys: true,
    maximumAttempts: 1,
    retriesAllowed: false,
    sharedEnvironmentTargetAllowed: false,
    stagedPatchAllowed: false,
    deploymentDeltaAllowed: false,
    externalMutationFreezeRequired: true,
  },
  evidence: {
    secretMaterialAllowed: false,
    secretDerivedCommitmentsAllowed: false,
    durableIntentRequiredBeforeAttempt: true,
    terminalEvidenceRequired: true,
    ambiguousOutcomeAction: "STOP_NO_RETRY",
  },
} as const);

export const PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_CANONICAL_POLICY_SOURCE =
  `${JSON.stringify(PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY, null, 2)}\n`;
export const PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY_SHA256 =
  createHash("sha256")
    .update(PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_CANONICAL_POLICY_SOURCE)
    .digest("hex");

interface ReplacementReferenceObservation {
  readonly sourceServiceId: string;
  readonly sourceVariableName: string;
}

interface ReplacementVariableObservation {
  readonly name: string;
  readonly serviceId: string | null;
  readonly isSealed: boolean;
  readonly reference: ReplacementReferenceObservation | null;
}

interface ReplacementDeploymentObservation {
  readonly id: string;
  readonly serviceId: string;
  readonly status: string;
}

export interface PermanentStagingSupabaseKeyReplacementObservation {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_OBSERVATION_SCHEMA;
  readonly projectId: string;
  readonly environmentId: string;
  readonly inventoryComplete: true;
  readonly externalMutationFreezeActive: true;
  readonly variables: readonly ReplacementVariableObservation[];
  readonly stagedPatchNames: readonly string[];
  readonly deployments: readonly ReplacementDeploymentObservation[];
}

export interface PermanentStagingSupabaseKeyReplacementAcknowledgement {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_ACK_SCHEMA;
  readonly operationName: "variableCollectionUpsert";
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly skipDeploys: true;
  readonly mergedVariableNames:
    typeof PERMANENT_STAGING_SUPABASE_KEY_NAMES;
  readonly acknowledged: true;
}

export interface PermanentStagingSupabaseKeyReplacementIntent {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_INTENT_SCHEMA;
  readonly policySha256: string;
  readonly operationName: "variableCollectionUpsert";
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly keyNames: typeof PERMANENT_STAGING_SUPABASE_KEY_NAMES;
  readonly keyFormats: readonly ["sb_publishable", "sb_secret", "sb_secret"];
  readonly mergeCardinality: "exactly-one-all-or-nothing";
  readonly skipDeploys: true;
  readonly attemptOrdinal: 1;
  readonly secretMaterialIncluded: false;
  readonly secretDerivedCommitmentsIncluded: false;
  readonly evidenceAuthority: "fixture-only-not-launch-evidence";
}

export interface PermanentStagingSupabaseKeyReplacementTerminal {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_TERMINAL_SCHEMA;
  readonly policySha256: string;
  readonly outcome: "passed" | "ambiguous-stop-no-retry" | "failed-before-attempt";
  readonly attempts: 0 | 1;
  readonly retryAllowed: false;
  readonly checks: {
    readonly preflightExact: boolean;
    readonly intentDurable: boolean;
    readonly singleMergeAttempted: boolean;
    readonly acknowledgementExact: boolean;
    readonly postflightExact: boolean;
    readonly noSharedShadows: boolean;
    readonly noStagedPatch: boolean;
    readonly deploymentUnchanged: boolean;
    readonly externalMutationFreezeActive: boolean;
  };
  readonly secretMaterialIncluded: false;
  readonly secretDerivedCommitmentsIncluded: false;
  readonly evidenceAuthority: "fixture-only-not-launch-evidence";
}

export interface PermanentStagingSupabaseKeyReplacementTransportRequest {
  readonly operationName: "variableCollectionUpsert";
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly variables: Readonly<PermanentStagingSupabaseKeyBuffers>;
  readonly skipDeploys: true;
  readonly attemptOrdinal: 1;
}

export interface PermanentStagingSupabaseKeyReplacementFixtureTransportResult {
  readonly acknowledgementSource: string;
  readonly postflightSource: string;
}

export interface PermanentStagingSupabaseKeyReplacementFixtureDependencies {
  readonly fixtureOnly: true;
  readonly preflightSource: string;
  readonly custody: PermanentStagingSupabaseKeyCustody;
  readonly signal: AbortSignal;
  readonly persistIntent: (
    intent: PermanentStagingSupabaseKeyReplacementIntent,
  ) => Promise<void>;
  readonly transport: (
    request: PermanentStagingSupabaseKeyReplacementTransportRequest,
    signal: AbortSignal,
  ) => Promise<PermanentStagingSupabaseKeyReplacementFixtureTransportResult>;
  readonly persistTerminal: (
    terminal: PermanentStagingSupabaseKeyReplacementTerminal,
  ) => Promise<void>;
}

const VARIABLE_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;
const DEPLOYMENT_STATUSES = deepFreeze([
  "CRASHED",
  "DEPLOYING",
  "FAILED",
  "INITIALIZING",
  "NEEDS_APPROVAL",
  "QUEUED",
  "REMOVED",
  "SKIPPED",
  "SUCCESS",
  "WAITING",
]);

function validVariableName(value: unknown): value is string {
  return typeof value === "string" && regexpTest(VARIABLE_NAME_PATTERN, value);
}

function validReference(value: unknown): value is ReplacementReferenceObservation {
  return exactDataRecord(value, ["sourceServiceId", "sourceVariableName"])
    && isExactUuid(value.sourceServiceId)
    && typeof value.sourceVariableName === "string"
    && regexpTest(VARIABLE_NAME_PATTERN, value.sourceVariableName);
}

function validVariable(value: unknown): value is ReplacementVariableObservation {
  return exactDataRecord(value, ["name", "serviceId", "isSealed", "reference"])
    && typeof value.name === "string"
    && regexpTest(VARIABLE_NAME_PATTERN, value.name)
    && (value.serviceId === null || isExactUuid(value.serviceId))
    && typeof value.isSealed === "boolean"
    && (value.reference === null || validReference(value.reference))
    && (value.reference === null || value.serviceId !== null);
}

function validDeployment(
  value: unknown,
): value is ReplacementDeploymentObservation {
  return exactDataRecord(value, ["id", "serviceId", "status"])
    && isExactUuid(value.id)
    && isExactUuid(value.serviceId)
    && typeof value.status === "string"
    && arrayIncludes(DEPLOYMENT_STATUSES, value.status);
}

export function parsePermanentStagingSupabaseKeyReplacementPolicy(
  source: unknown,
): typeof PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY | null {
  return source === PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_CANONICAL_POLICY_SOURCE
    ? PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY
    : null;
}

export function parsePermanentStagingSupabaseKeyReplacementObservation(
  source: unknown,
): PermanentStagingSupabaseKeyReplacementObservation | null {
  const value = parseCanonicalJson(source);
  if (
    !exactDataRecord(value, [
      "schemaVersion",
      "projectId",
      "environmentId",
      "inventoryComplete",
      "externalMutationFreezeActive",
      "variables",
      "stagedPatchNames",
      "deployments",
    ])
    || value.schemaVersion
      !== PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_OBSERVATION_SCHEMA
    || !isExactUuid(value.projectId)
    || !isExactUuid(value.environmentId)
    || value.inventoryComplete !== true
    || value.externalMutationFreezeActive !== true
    || !denseArray(value.variables, 2_000)
    || !arrayEvery(value.variables, validVariable)
    || !denseArray(value.stagedPatchNames, 256)
    || !arrayEvery(value.stagedPatchNames, validVariableName)
    || !uniqueStrings(value.stagedPatchNames)
    || !denseArray(value.deployments, 2_000)
    || !arrayEvery(value.deployments, validDeployment)
  ) return null;
  const variableIdentities = arrayMap(value.variables, (row) =>
    `${row.serviceId ?? "shared"}:${row.name}`);
  const deploymentIdentities = arrayMap(value.deployments, (row) => row.id);
  if (
    !uniqueStrings(variableIdentities)
    || !uniqueStrings(deploymentIdentities)
  ) return null;
  return deepFreeze(value as unknown as PermanentStagingSupabaseKeyReplacementObservation);
}

export function parsePermanentStagingSupabaseKeyReplacementAcknowledgement(
  source: unknown,
): PermanentStagingSupabaseKeyReplacementAcknowledgement | null {
  const value = parseCanonicalJson(source, 16_384);
  if (
    !exactDataRecord(value, [
      "schemaVersion",
      "operationName",
      "projectId",
      "environmentId",
      "serviceId",
      "skipDeploys",
      "mergedVariableNames",
      "acknowledged",
    ])
    || value.schemaVersion
      !== PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_ACK_SCHEMA
    || value.operationName !== "variableCollectionUpsert"
    || value.projectId
      !== PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY.railwayTarget.projectId
    || value.environmentId
      !== PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY.railwayTarget.environmentId
    || value.serviceId
      !== PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY.railwayTarget.applicationServiceId
    || value.skipDeploys !== true
    || !denseArray(value.mergedVariableNames, 3)
    || value.mergedVariableNames.length !== 3
    || arraySome(value.mergedVariableNames, (name, index) =>
      name !== PERMANENT_STAGING_SUPABASE_KEY_NAMES[index])
    || value.acknowledged !== true
  ) return null;
  return deepFreeze(value as unknown as PermanentStagingSupabaseKeyReplacementAcknowledgement);
}

function exactKeyInventory(
  observation: PermanentStagingSupabaseKeyReplacementObservation,
): boolean {
  const relevant = arrayFilter(observation.variables, (row) =>
    arrayIncludes(
      PERMANENT_STAGING_SUPABASE_KEY_NAMES as readonly string[],
      row.name,
    ));
  if (relevant.length !== 6) return false;
  return arrayEvery(
    PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY.keys,
    (key) => {
    const rows = arrayFilter(relevant, (row) => row.name === key.name);
    if (rows.length !== 2) return false;
    const target = arrayFind(rows, (row) => row.serviceId === key.targetServiceId);
    const reference = arrayFind(rows, (row) =>
      row.serviceId === key.allowedReferenceServiceId);
    return target?.isSealed === key.expectedSealed
      && target.reference === null
      && reference !== undefined
      && reference.isSealed === key.expectedSealed
      && reference.reference?.sourceServiceId === key.targetServiceId
      && reference.reference.sourceVariableName === key.name;
    },
  );
}

export interface PermanentStagingSupabaseKeyReplacementEvaluation {
  readonly targetExact: boolean;
  readonly noSharedShadows: boolean;
  readonly noStagedPatch: boolean;
  readonly deploymentUnchanged: boolean;
  readonly externalMutationFreezeActive: boolean;
  readonly passed: boolean;
}

export function evaluatePermanentStagingSupabaseKeyReplacementState(
  before: PermanentStagingSupabaseKeyReplacementObservation,
  acknowledgement: PermanentStagingSupabaseKeyReplacementAcknowledgement,
  after: PermanentStagingSupabaseKeyReplacementObservation,
): PermanentStagingSupabaseKeyReplacementEvaluation {
  const targetExact = before.projectId
      === PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY.railwayTarget.projectId
    && after.projectId === before.projectId
    && before.environmentId
      === PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY.railwayTarget.environmentId
    && after.environmentId === before.environmentId
    && acknowledgement.projectId === before.projectId
    && acknowledgement.environmentId === before.environmentId
    && acknowledgement.serviceId
      === PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY.railwayTarget.applicationServiceId;
  const noSharedShadows = exactKeyInventory(before) && exactKeyInventory(after);
  const noStagedPatch = before.stagedPatchNames.length === 0
    && after.stagedPatchNames.length === 0;
  const deploymentUnchanged = canonicalJson(before.deployments)
    === canonicalJson(after.deployments);
  const externalMutationFreezeActive = before.externalMutationFreezeActive
    && after.externalMutationFreezeActive;
  return deepFreeze({
    targetExact,
    noSharedShadows,
    noStagedPatch,
    deploymentUnchanged,
    externalMutationFreezeActive,
    passed: targetExact && noSharedShadows && noStagedPatch && deploymentUnchanged
      && externalMutationFreezeActive,
  });
}

function intent(): PermanentStagingSupabaseKeyReplacementIntent {
  const target = PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY.railwayTarget;
  return deepFreeze({
    schemaVersion: PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_INTENT_SCHEMA,
    policySha256: PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY_SHA256,
    operationName: "variableCollectionUpsert",
    projectId: target.projectId,
    environmentId: target.environmentId,
    serviceId: target.applicationServiceId,
    keyNames: PERMANENT_STAGING_SUPABASE_KEY_NAMES,
    keyFormats: ["sb_publishable", "sb_secret", "sb_secret"] as const,
    mergeCardinality: "exactly-one-all-or-nothing",
    skipDeploys: true,
    attemptOrdinal: 1,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
    evidenceAuthority: "fixture-only-not-launch-evidence",
  });
}

function terminal(
  outcome: PermanentStagingSupabaseKeyReplacementTerminal["outcome"],
  attempts: 0 | 1,
  checks: PermanentStagingSupabaseKeyReplacementTerminal["checks"],
): PermanentStagingSupabaseKeyReplacementTerminal {
  return deepFreeze({
    schemaVersion: PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_TERMINAL_SCHEMA,
    policySha256: PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY_SHA256,
    outcome,
    attempts,
    retryAllowed: false,
    checks,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
    evidenceAuthority: "fixture-only-not-launch-evidence",
  });
}

async function persistTerminalOrThrow(
  persist: PermanentStagingSupabaseKeyReplacementFixtureDependencies["persistTerminal"],
  receipt: PermanentStagingSupabaseKeyReplacementTerminal,
): Promise<void> {
  try {
    await persist(receipt);
  } catch {
    throw new Error("terminal_persistence_failed");
  }
}

const EMPTY_CHECKS = freezeExact({
  preflightExact: false,
  intentDurable: false,
  singleMergeAttempted: false,
  acknowledgementExact: false,
  postflightExact: false,
  noSharedShadows: false,
  noStagedPatch: false,
  deploymentUnchanged: false,
  externalMutationFreezeActive: false,
});

/**
 * Offline fixture kernel only. It has no provider transport implementation and
 * is intentionally not called by the hard-disabled CLI.
 */
export async function runPermanentStagingSupabaseKeyReplacementFixtureAttempt(
  dependencies: PermanentStagingSupabaseKeyReplacementFixtureDependencies,
): Promise<PermanentStagingSupabaseKeyReplacementTerminal> {
  if (
    !exactDataRecord(dependencies, [
      "fixtureOnly",
      "preflightSource",
      "custody",
      "signal",
      "persistIntent",
      "transport",
      "persistTerminal",
    ])
    || dependencies.fixtureOnly !== true
    || typeof dependencies.preflightSource !== "string"
    || !isPermanentStagingSupabaseKeyCustody(dependencies.custody)
    || !isExactPermanentStagingSupabaseAbortSignal(dependencies.signal)
    || isPermanentStagingSupabaseSignalAborted(dependencies.signal)
    || typeof dependencies.persistIntent !== "function"
    || typeof dependencies.transport !== "function"
    || typeof dependencies.persistTerminal !== "function"
  ) {
    if (typeof dependencies === "object" && dependencies !== null) {
      const candidate = (dependencies as { custody?: unknown }).custody;
      if (isPermanentStagingSupabaseKeyCustody(candidate)) candidate.close();
    }
    throw new Error("fixture_contract_invalid");
  }

  const before = parsePermanentStagingSupabaseKeyReplacementObservation(
    dependencies.preflightSource,
  );
  const preflightExact = before !== null
    && before.projectId
      === PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY.railwayTarget.projectId
    && before.environmentId
      === PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY.railwayTarget.environmentId
    && exactKeyInventory(before)
    && before.stagedPatchNames.length === 0;
  if (!preflightExact) {
    dependencies.custody.close();
    const receipt = terminal("failed-before-attempt", 0, EMPTY_CHECKS);
    await persistTerminalOrThrow(dependencies.persistTerminal, receipt);
    return receipt;
  }

  try {
    dependencies.custody.inspect();
  } catch {
    dependencies.custody.close();
    const receipt = terminal("failed-before-attempt", 0, {
      ...EMPTY_CHECKS,
      preflightExact: true,
      externalMutationFreezeActive: true,
    });
    await persistTerminalOrThrow(dependencies.persistTerminal, receipt);
    return receipt;
  }
  const durableIntent = intent();
  try {
    await dependencies.persistIntent(durableIntent);
  } catch {
    dependencies.custody.close();
    const receipt = terminal("failed-before-attempt", 0, {
      ...EMPTY_CHECKS,
      preflightExact: true,
    });
    try {
      await dependencies.persistTerminal(receipt);
    } catch {
      // The fixed thrown code below is authoritative; never expose writer data.
    }
    throw new Error("intent_persistence_failed");
  }

  let raw: PermanentStagingSupabaseKeyReplacementFixtureTransportResult | null = null;
  let transportEntered = false;
  try {
    raw = await dependencies.custody.useExactlyOnce(async (keys, signal) => {
      transportEntered = true;
      const target = PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY.railwayTarget;
      return await dependencies.transport(freezeExact({
        operationName: "variableCollectionUpsert",
        projectId: target.projectId,
        environmentId: target.environmentId,
        serviceId: target.applicationServiceId,
        variables: keys,
        skipDeploys: true,
        attemptOrdinal: 1,
      }), signal);
    }, dependencies.signal);
  } catch {
    const receipt = terminal(
      transportEntered ? "ambiguous-stop-no-retry" : "failed-before-attempt",
      transportEntered ? 1 : 0,
      {
      ...EMPTY_CHECKS,
      preflightExact: true,
      intentDurable: true,
      singleMergeAttempted: transportEntered,
      externalMutationFreezeActive: true,
    });
    await persistTerminalOrThrow(dependencies.persistTerminal, receipt);
    return receipt;
  }

  const rawExact = exactDataRecord(raw, ["acknowledgementSource", "postflightSource"])
    && typeof raw.acknowledgementSource === "string"
    && typeof raw.postflightSource === "string";
  const acknowledgement = rawExact
    ? parsePermanentStagingSupabaseKeyReplacementAcknowledgement(
      raw.acknowledgementSource,
    )
    : null;
  const after = rawExact
    ? parsePermanentStagingSupabaseKeyReplacementObservation(raw.postflightSource)
    : null;
  const evaluation = acknowledgement && after
    ? evaluatePermanentStagingSupabaseKeyReplacementState(before, acknowledgement, after)
    : null;
  const passed = acknowledgement !== null && after !== null && evaluation?.passed === true;
  const receipt = terminal(
    passed ? "passed" : "ambiguous-stop-no-retry",
    1,
    {
      preflightExact: true,
      intentDurable: true,
      singleMergeAttempted: true,
      acknowledgementExact: acknowledgement !== null,
      postflightExact: after !== null,
      noSharedShadows: evaluation?.noSharedShadows === true,
      noStagedPatch: evaluation?.noStagedPatch === true,
      deploymentUnchanged: evaluation?.deploymentUnchanged === true,
      externalMutationFreezeActive:
        evaluation?.externalMutationFreezeActive === true,
    },
  );
  await persistTerminalOrThrow(dependencies.persistTerminal, receipt);
  return receipt;
}

export const PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_BLOCKED_RECEIPT =
  terminal("failed-before-attempt", 0, EMPTY_CHECKS);
