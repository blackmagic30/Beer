import {
  arrayEvery,
  arrayMap,
  deepFreeze,
  denseArray,
  exactDataRecord,
  parseCanonicalJson,
  regexpTest,
  stringReplace,
  uniqueStrings,
} from "./permanent-staging-supabase-containment-primitives.js";

export const PERMANENT_STAGING_SUPABASE_LEGACY_KEY_STATE_SCHEMA =
  "pintpath-permanent-staging-supabase-legacy-key-state/v1" as const;
export const PERMANENT_STAGING_SUPABASE_LEGACY_KEY_RESPONSE_SCHEMA =
  "pintpath-permanent-staging-supabase-legacy-key-disable-response/v1" as const;

export const PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_POLICY = deepFreeze({
  schemaVersion: "pintpath-permanent-staging-supabase-legacy-key-disable-policy/v1",
  policyId: "permanent-staging-legacy-api-key-disable",
  activationState: "HARD_DISABLED_REVIEW_REQUIRED",
  projects: [
    {
      role: "permanent-staging",
      projectRef: "bbfibbadwjxzrcdncavy",
      legacyKeyIds: { anon: null, serviceRole: null },
      reviewRequired: true,
    },
  ],
  disableRequest: {
    method: "PUT",
    pathTemplate: "/v1/projects/{projectRef}/api-keys/legacy?enabled=false",
    exactResponse: { enabled: false },
    maximumAttemptsPerProject: 1,
    retriesAllowed: false,
  },
  proof: {
    beforeEnabledRequired: true,
    afterEnabledRequired: false,
    oldKeyDenialRequired: true,
    ambiguousDenialAction: "STOP_NO_RETRY",
  },
} as const);

export const PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_CANONICAL_POLICY_SOURCE =
  `${JSON.stringify(PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_POLICY, null, 2)}\n`;

interface LegacyKeyProjectState {
  readonly role: "permanent-staging";
  readonly projectRef: string;
  readonly enabled: boolean;
}

export interface PermanentStagingSupabaseLegacyKeyStateSnapshot {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_SUPABASE_LEGACY_KEY_STATE_SCHEMA;
  readonly source: "fixture-only";
  readonly phase: "before" | "after";
  readonly projects: readonly LegacyKeyProjectState[];
}

interface LegacyKeyDisableResponse {
  readonly projectRef: string;
  readonly response: { readonly enabled: false };
}

export interface PermanentStagingSupabaseLegacyKeyDisableResponses {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_SUPABASE_LEGACY_KEY_RESPONSE_SCHEMA;
  readonly source: "fixture-only";
  readonly responses: readonly LegacyKeyDisableResponse[];
}

function exactProjectRef(value: unknown): value is string {
  return typeof value === "string" && regexpTest(/^[a-z]{20}$/, value);
}

function validProjectState(value: unknown): value is LegacyKeyProjectState {
  return exactDataRecord(value, ["role", "projectRef", "enabled"])
    && value.role === "permanent-staging"
    && exactProjectRef(value.projectRef)
    && typeof value.enabled === "boolean";
}

function validDisableResponse(value: unknown): value is LegacyKeyDisableResponse {
  return exactDataRecord(value, ["projectRef", "response"])
    && exactProjectRef(value.projectRef)
    && exactDataRecord(value.response, ["enabled"])
    && value.response.enabled === false;
}

export function parsePermanentStagingSupabaseLegacyKeyDisablePolicy(
  source: unknown,
): typeof PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_POLICY | null {
  return source
      === PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_CANONICAL_POLICY_SOURCE
    ? PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_POLICY
    : null;
}

export function parsePermanentStagingSupabaseLegacyKeyStateSnapshot(
  source: unknown,
): PermanentStagingSupabaseLegacyKeyStateSnapshot | null {
  const value = parseCanonicalJson(source, 32_768);
  if (
    !exactDataRecord(value, ["schemaVersion", "source", "phase", "projects"])
    || value.schemaVersion !== PERMANENT_STAGING_SUPABASE_LEGACY_KEY_STATE_SCHEMA
    || value.source !== "fixture-only"
    || (value.phase !== "before" && value.phase !== "after")
    || !denseArray(value.projects, 1)
    || value.projects.length !== 1
    || !arrayEvery(value.projects, validProjectState)
    || !uniqueStrings(arrayMap(value.projects, (project) => project.projectRef))
  ) return null;
  return deepFreeze(value as unknown as PermanentStagingSupabaseLegacyKeyStateSnapshot);
}

export function parsePermanentStagingSupabaseLegacyKeyDisableResponses(
  source: unknown,
): PermanentStagingSupabaseLegacyKeyDisableResponses | null {
  const value = parseCanonicalJson(source, 32_768);
  if (
    !exactDataRecord(value, ["schemaVersion", "source", "responses"])
    || value.schemaVersion
      !== PERMANENT_STAGING_SUPABASE_LEGACY_KEY_RESPONSE_SCHEMA
    || value.source !== "fixture-only"
    || !denseArray(value.responses, 1)
    || value.responses.length !== 1
    || !arrayEvery(value.responses, validDisableResponse)
    || !uniqueStrings(arrayMap(value.responses, (response) => response.projectRef))
  ) return null;
  return deepFreeze(value as unknown as PermanentStagingSupabaseLegacyKeyDisableResponses);
}

export interface PermanentStagingSupabaseLegacyKeyDisableEvaluation {
  readonly outcome: "passed" | "blocked-review-required" | "failed";
  readonly projectsExact: boolean;
  readonly beforeEnabledExact: boolean;
  readonly disableResponsesExact: boolean;
  readonly afterDisabledExact: boolean;
  readonly legacyKeyIdsReviewed: boolean;
  readonly policyActivated: boolean;
  readonly requests: readonly {
    readonly method: "PUT";
    readonly path: string;
    readonly maximumAttempts: 1;
    readonly retryAllowed: false;
  }[];
}

export function evaluatePermanentStagingSupabaseLegacyKeyDisable(
  before: PermanentStagingSupabaseLegacyKeyStateSnapshot,
  responses: PermanentStagingSupabaseLegacyKeyDisableResponses,
  after: PermanentStagingSupabaseLegacyKeyStateSnapshot,
): PermanentStagingSupabaseLegacyKeyDisableEvaluation {
  const policy = PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_POLICY;
  const projectsExact = before.phase === "before"
    && after.phase === "after"
    && before.projects.length === policy.projects.length
    && after.projects.length === policy.projects.length
    && responses.responses.length === policy.projects.length
    && arrayEvery(policy.projects, (expected, index) =>
      before.projects[index]?.role === expected.role
      && before.projects[index]?.projectRef === expected.projectRef
      && after.projects[index]?.role === expected.role
      && after.projects[index]?.projectRef === expected.projectRef
      && responses.responses[index]?.projectRef === expected.projectRef);
  const beforeEnabledExact = projectsExact
    && arrayEvery(before.projects, (project) => project.enabled === true);
  const disableResponsesExact = projectsExact
    && arrayEvery(responses.responses, (result) =>
      result.response.enabled === false);
  const afterDisabledExact = projectsExact
    && arrayEvery(after.projects, (project) => project.enabled === false);
  const legacyKeyIdsReviewed = arrayEvery(policy.projects, (project) => {
    const anon = project.legacyKeyIds.anon as unknown;
    const serviceRole = project.legacyKeyIds.serviceRole as unknown;
    return typeof anon === "string"
      && anon.length > 0
      && typeof serviceRole === "string"
      && serviceRole.length > 0
      && (project.reviewRequired as boolean) === false;
  });
  const policyActivated = policy.activationState === ("ENABLED_REVIEWED" as string);
  const structuralPassed = projectsExact && beforeEnabledExact
    && disableResponsesExact && afterDisabledExact;
  return deepFreeze({
    outcome: structuralPassed && legacyKeyIdsReviewed && policyActivated
      ? "passed"
      : !legacyKeyIdsReviewed || !policyActivated
        ? "blocked-review-required"
        : "failed",
    projectsExact,
    beforeEnabledExact,
    disableResponsesExact,
    afterDisabledExact,
    legacyKeyIdsReviewed,
    policyActivated,
    requests: arrayMap(policy.projects, (project) => ({
      method: "PUT" as const,
      path: stringReplace(policy.disableRequest.pathTemplate,
        "{projectRef}",
        project.projectRef,
      ),
      maximumAttempts: 1 as const,
      retryAllowed: false as const,
    })),
  });
}
