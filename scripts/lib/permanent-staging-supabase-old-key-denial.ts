import {
  arrayFind,
  deepFreeze,
  exactDataRecord,
  freezeExact,
  isExactUuid,
  parseCanonicalJson,
} from "./permanent-staging-supabase-containment-primitives.js";
import {
  PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_POLICY,
} from "./permanent-staging-supabase-legacy-key-disable.js";

export const PERMANENT_STAGING_SUPABASE_OLD_KEY_DENIAL_FIXTURE_SCHEMA =
  "pintpath-permanent-staging-supabase-old-key-denial-fixture/v1" as const;

export type PermanentStagingSupabaseOldKeyDenialClassification =
  | "denied"
  | "not-denied"
  | "ambiguous";

export interface PermanentStagingSupabaseOldKeyDenialFixture {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_SUPABASE_OLD_KEY_DENIAL_FIXTURE_SCHEMA;
  readonly source: "fixture-only";
  readonly projectRole: "permanent-staging" | "operational-offsite-copy";
  readonly projectRef: string;
  readonly keyFamily: "anon" | "serviceRole";
  readonly legacyKeyId: string | null;
  readonly request: {
    readonly method: "GET";
    readonly readOnly: true;
    readonly canaryClass:
      | "staging-auth-settings"
      | "staging-auth-admin-list-limit-one"
      | "offsite-auth-settings"
      | "offsite-private-storage-bucket";
  };
  readonly response: {
    readonly transportCompleted: boolean;
    readonly status: number | null;
    readonly apiKeyDecision: "accepted" | "rejected" | "unknown";
  };
}

const PROJECTS = freezeExact({
  "permanent-staging": "bbfibbadwjxzrcdncavy",
  "operational-offsite-copy": "hfbmhdxrwtihukmixxta",
} as const);
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;

function expectedCanaryClass(
  role: PermanentStagingSupabaseOldKeyDenialFixture["projectRole"],
  family: PermanentStagingSupabaseOldKeyDenialFixture["keyFamily"],
): PermanentStagingSupabaseOldKeyDenialFixture["request"]["canaryClass"] {
  if (role === "permanent-staging") {
    return family === "anon"
      ? "staging-auth-settings"
      : "staging-auth-admin-list-limit-one";
  }
  return family === "anon"
    ? "offsite-auth-settings"
    : "offsite-private-storage-bucket";
}

export function parsePermanentStagingSupabaseOldKeyDenialFixture(
  source: unknown,
): PermanentStagingSupabaseOldKeyDenialFixture | null {
  const value = parseCanonicalJson(source, 16_384);
  if (
    !exactDataRecord(value, [
      "schemaVersion",
      "source",
      "projectRole",
      "projectRef",
      "keyFamily",
      "legacyKeyId",
      "request",
      "response",
    ])
    || value.schemaVersion
      !== PERMANENT_STAGING_SUPABASE_OLD_KEY_DENIAL_FIXTURE_SCHEMA
    || value.source !== "fixture-only"
    || (value.projectRole !== "permanent-staging"
      && value.projectRole !== "operational-offsite-copy")
    || value.projectRef !== PROJECTS[value.projectRole]
    || (value.keyFamily !== "anon" && value.keyFamily !== "serviceRole")
    || (value.legacyKeyId !== null
      && (typeof value.legacyKeyId !== "string"
        || !isExactUuid(value.legacyKeyId)))
    || !exactDataRecord(value.request, ["method", "readOnly", "canaryClass"])
    || value.request.method !== "GET"
    || value.request.readOnly !== true
    || value.request.canaryClass
      !== expectedCanaryClass(value.projectRole, value.keyFamily)
    || !exactDataRecord(value.response, [
      "transportCompleted",
      "status",
      "apiKeyDecision",
    ])
    || typeof value.response.transportCompleted !== "boolean"
    || (value.response.status !== null
      && (typeof value.response.status !== "number"
        || !NUMBER_IS_SAFE_INTEGER(value.response.status)
        || value.response.status < 100
        || value.response.status > 599))
    || (value.response.apiKeyDecision !== "accepted"
      && value.response.apiKeyDecision !== "rejected"
      && value.response.apiKeyDecision !== "unknown")
    || (value.response.transportCompleted === false
      && (value.response.status !== null
        || value.response.apiKeyDecision !== "unknown"))
  ) return null;
  return deepFreeze(value as unknown as PermanentStagingSupabaseOldKeyDenialFixture);
}

export interface PermanentStagingSupabaseOldKeyDenialResult {
  readonly classification: PermanentStagingSupabaseOldKeyDenialClassification;
  readonly evidenceEligible: boolean;
  readonly legacyKeyIdPolicyExact: boolean;
  readonly ambiguousOutcomeAction: "STOP_NO_RETRY";
  readonly keyMaterialIncluded: false;
  readonly reason:
    | "exact-gateway-rejection"
    | "gateway-accepted-old-key"
    | "legacy-key-id-review-required"
    | "legacy-key-id-policy-mismatch"
    | "ambiguous-provider-outcome";
}

export function classifyPermanentStagingSupabaseOldKeyDenial(
  fixture: PermanentStagingSupabaseOldKeyDenialFixture,
): PermanentStagingSupabaseOldKeyDenialResult {
  const denied = fixture.response.transportCompleted
    && fixture.response.status === 401
    && fixture.response.apiKeyDecision === "rejected";
  const notDenied = fixture.response.transportCompleted
    && fixture.response.status !== null
    && fixture.response.status >= 200
    && fixture.response.status <= 299
    && fixture.response.apiKeyDecision === "accepted";
  const classification: PermanentStagingSupabaseOldKeyDenialClassification =
    denied ? "denied" : notDenied ? "not-denied" : "ambiguous";
  const project = arrayFind(
    PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_POLICY.projects,
    (candidate) => candidate.role === fixture.projectRole,
  );
  const expectedId = project?.legacyKeyIds[fixture.keyFamily] as unknown;
  const policyHasReviewedId = typeof expectedId === "string"
    && expectedId.length > 0
    && project?.reviewRequired === (false as boolean);
  const legacyKeyIdPolicyExact = policyHasReviewedId
    && fixture.legacyKeyId === expectedId;
  return deepFreeze({
    classification,
    evidenceEligible: denied && legacyKeyIdPolicyExact,
    legacyKeyIdPolicyExact,
    ambiguousOutcomeAction: "STOP_NO_RETRY",
    keyMaterialIncluded: false,
    reason: notDenied
      ? "gateway-accepted-old-key"
      : !denied
        ? "ambiguous-provider-outcome"
        : !policyHasReviewedId
          ? "legacy-key-id-review-required"
          : !legacyKeyIdPolicyExact
            ? "legacy-key-id-policy-mismatch"
            : "exact-gateway-rejection",
  });
}
