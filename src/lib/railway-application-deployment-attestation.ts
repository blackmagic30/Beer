import crypto from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";
import { URL as NodeUrl } from "node:url";

import { railwayDeploymentIdentityIdSha256 } from
  "./railway-deployment-identity.js";

// These are security boundaries, not convenience aliases. The attestor and
// promotion planner run in a process which also loads application code, so a
// prototype mutation after this module is initialized must not be able to
// relax evidence parsing, comparison, or hashing.
const ARRAY_IS_ARRAY = Array.isArray;
const BUFFER_CONSTRUCTOR = Buffer;
const BUFFER_ALLOC = BUFFER_CONSTRUCTOR.alloc;
const BUFFER_BYTE_LENGTH = BUFFER_CONSTRUCTOR.byteLength;
const BUFFER_IS_BUFFER = BUFFER_CONSTRUCTOR.isBuffer;
const BUFFER_PROTOTYPE = BUFFER_CONSTRUCTOR.prototype;
const CRYPTO_CREATE_HASH = crypto.createHash;
const CRYPTO_TIMING_SAFE_EQUAL = crypto.timingSafeEqual;
const DATE_CONSTRUCTOR = Date;
const DATE_GET_TIME = Date.prototype.getTime;
const DATE_PARSE = Date.parse;
const DATE_TO_ISO_STRING = Date.prototype.toISOString;
const JSON_OBJECT = JSON;
const JSON_PARSE = JSON_OBJECT.parse;
const JSON_STRINGIFY = JSON_OBJECT.stringify;
const NUMBER_CONSTRUCTOR = Number;
const NUMBER_IS_FINITE = NUMBER_CONSTRUCTOR.isFinite;
const NUMBER_IS_SAFE_INTEGER = NUMBER_CONSTRUCTOR.isSafeInteger;
const NUMBER_TO_STRING = NUMBER_CONSTRUCTOR.prototype.toString;
const OBJECT_CONSTRUCTOR = Object;
const OBJECT_FREEZE = OBJECT_CONSTRUCTOR.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = OBJECT_CONSTRUCTOR.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = OBJECT_CONSTRUCTOR.getPrototypeOf;
const OBJECT_HAS_OWN = OBJECT_CONSTRUCTOR.hasOwn;
const OBJECT_KEYS = OBJECT_CONSTRUCTOR.keys;
const OBJECT_PROTOTYPE = OBJECT_CONSTRUCTOR.prototype;
const REFLECT_OBJECT = Reflect;
const REFLECT_APPLY = REFLECT_OBJECT.apply;
const REFLECT_DEFINE_PROPERTY = REFLECT_OBJECT.defineProperty;
const REGEXP_EXEC = RegExp.prototype.exec;
const STRING_ENDS_WITH = String.prototype.endsWith;
const STRING_INCLUDES = String.prototype.includes;
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const TEXT_ENCODER_ENCODE = TextEncoder.prototype.encode;
const TYPED_ARRAY_LENGTH_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  OBJECT_GET_PROTOTYPE_OF(Uint8Array.prototype),
  "length",
)!.get!;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();
const URL_PROTOCOL_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  NodeUrl.prototype,
  "protocol",
)!.get!;
const URL_USERNAME_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  NodeUrl.prototype,
  "username",
)!.get!;
const URL_PASSWORD_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  NodeUrl.prototype,
  "password",
)!.get!;
const URL_PORT_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  NodeUrl.prototype,
  "port",
)!.get!;
const URL_PATHNAME_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  NodeUrl.prototype,
  "pathname",
)!.get!;
const URL_SEARCH_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  NodeUrl.prototype,
  "search",
)!.get!;
const URL_HASH_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  NodeUrl.prototype,
  "hash",
)!.get!;
const URL_HOSTNAME_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  NodeUrl.prototype,
  "hostname",
)!.get!;
const URL_ORIGIN_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  NodeUrl.prototype,
  "origin",
)!.get!;

const HASH_PROBE = REFLECT_APPLY(CRYPTO_CREATE_HASH, crypto, ["sha256"]);
const HASH_UPDATE = HASH_PROBE.update;
const HASH_DIGEST = HASH_PROBE.digest;
REFLECT_APPLY(HASH_DIGEST, HASH_PROBE, []);

export const RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SCHEMA_VERSION =
  "pintpath-railway-application-deployment-attestation-policy/v1" as const;
export const RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RECEIPT_SCHEMA_VERSION =
  "pintpath-railway-application-deployment-attestation-receipt/v1" as const;
export const RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SHA256 =
  "b056b175f981d7b51a9590943e209e82a0dfcbea650de7a4cb5ecf37a67bbdd1" as const;
export const RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_STATE =
  "READ_ONLY_OBSERVATION" as const;
export const RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RECEIPT_STATE =
  "READ_ONLY_EVIDENCE_LAUNCH_BLOCKER_RETAINED" as const;
export const RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_POLICY_BYTES =
  16 * 1_024;
export const RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_PROVIDER_RESPONSE_BYTES =
  1_024 * 1_024;
export const RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_RUNTIME_RESPONSE_BYTES =
  1_024 * 1_024;
export const RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_RECEIPT_BYTES =
  64 * 1_024;

const POLICY_ID =
  "pintpath-permanent-staging-application-deployment-attestation" as const;
const GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2" as const;
const EXPECTED_ENVIRONMENT = "permanent-staging" as const;
export const RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK = OBJECT_FREEZE({
  projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  stagingEnvironmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
  forbiddenProductionEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
  forbiddenProductionServiceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
} as const);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANDIDATE_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_VERSION_PATTERN = /^[a-z0-9._-]{1,80}$/i;
const RESTORE_MARKER_PATTERN = /restore/i;
const RUNTIME_ROUTES = ["/health", "/startup", "/ready"] as const;
const CHECK_KEYS = [
  "policyExact",
  "queriesReadOnly",
  "tokenScopeExact",
  "patchEmptyBefore",
  "patchEmptyAfter",
  "providerTargetExact",
  "providerSnapshotStable",
  "deploymentSuccessful",
  "providerOriginAttached",
  "candidateExact",
  "runtimeRoutesExact",
  "runtimeIdentityExact",
  "singleReplicaExact",
  "restoreStateAbsent",
  "observationWindowBounded",
  "readOnlyStateRetained",
] as const;
const RECEIPT_HASH_KEYS = [
  "policySha256",
  "projectIdSha256",
  "environmentIdSha256",
  "serviceInstanceIdSha256",
  "serviceIdSha256",
  "deploymentIdSha256",
  "snapshotIdSha256",
  "imageDigestSha256",
  "targetOriginSha256",
  "providerSnapshotSha256",
  "healthResponseSha256",
  "startupResponseSha256",
  "readyResponseSha256",
  "replicaIdSha256s",
] as const;

type RuntimeRoute = typeof RUNTIME_ROUTES[number];
type CheckKey = typeof CHECK_KEYS[number];

export interface RailwayApplicationDeploymentAttestationPolicy {
  readonly schemaVersion: typeof RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SCHEMA_VERSION;
  readonly policyId: typeof POLICY_ID;
  readonly mode: "read-only-observation";
  readonly activationAuthorized: false;
  readonly launchBlockerRemoved: false;
  readonly graphqlEndpoint: typeof GRAPHQL_ENDPOINT;
  readonly projectId: string;
  readonly stagingEnvironmentId: string;
  readonly serviceId: string;
  readonly forbiddenProduction: {
    readonly environmentId: string;
    readonly serviceId: string;
  };
  readonly allowedDomainSuffix: ".up.railway.app";
  readonly runtimeRoutes: readonly ["/health", "/startup", "/ready"];
  readonly limits: {
    readonly maximumProviderResponseBytes: 1_048_576;
    readonly maximumRuntimeResponseBytes: 1_048_576;
    readonly maximumObservationSeconds: 120;
    readonly maximumReceiptAgeSeconds: 900;
  };
}

export interface RailwayApplicationDeploymentAttestationTokenScope {
  readonly projectId: string;
  readonly environmentId: string;
}

export interface RailwayApplicationDeploymentAttestationEmptyPatch {
  readonly environmentId: string;
  readonly patchEmpty: true;
}

interface ProviderDeploymentSummary {
  readonly id: string;
  readonly status: string;
  readonly deploymentStopped: boolean;
}

interface ProviderLatestDeployment extends ProviderDeploymentSummary {
  readonly snapshotId: string;
}

interface ProviderDomain {
  readonly kind: "service" | "custom";
  readonly id: string;
  readonly domain: string;
  readonly targetPort: number | null;
}

export interface RailwayApplicationDeploymentAttestationProviderSnapshot {
  readonly serviceInstanceId: string;
  readonly serviceId: string;
  readonly environmentId: string;
  readonly numReplicas: number;
  readonly latestDeployment: ProviderLatestDeployment;
  readonly activeDeployments: readonly ProviderDeploymentSummary[];
  readonly domains: readonly ProviderDomain[];
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

interface RuntimeDeployment {
  readonly version: string;
  readonly commitSha: string;
  readonly environment: "production";
  readonly projectIdSha256: string;
  readonly environmentIdSha256: string;
  readonly serviceIdSha256: string;
  readonly deploymentIdSha256: string;
  readonly replicaIdSha256: string;
}

export interface RailwayApplicationDeploymentAttestationRuntimeResponse {
  readonly route: RuntimeRoute;
  readonly service: "pint-path";
  readonly status: "ok" | "startup_ready" | "ready";
  readonly deployment: RuntimeDeployment;
  readonly restoreMarkerPresent: false;
  readonly responseSha256: string;
}

export type RailwayApplicationDeploymentAttestationChecks = Readonly<
  Record<CheckKey, true>
>;

export interface RailwayApplicationDeploymentAttestationEvaluationInput {
  readonly policy: RailwayApplicationDeploymentAttestationPolicy;
  readonly policySha256: string;
  readonly candidateSha: string;
  readonly targetOrigin: string;
  readonly targetOriginSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly queriesReadOnly: boolean;
  readonly tokenScope: RailwayApplicationDeploymentAttestationTokenScope;
  readonly patchBefore: RailwayApplicationDeploymentAttestationEmptyPatch;
  readonly providerBefore: RailwayApplicationDeploymentAttestationProviderSnapshot;
  readonly runtime: {
    readonly health: RailwayApplicationDeploymentAttestationRuntimeResponse;
    readonly startup: RailwayApplicationDeploymentAttestationRuntimeResponse;
    readonly ready: RailwayApplicationDeploymentAttestationRuntimeResponse;
  };
  readonly patchAfter: RailwayApplicationDeploymentAttestationEmptyPatch;
  readonly providerAfter: RailwayApplicationDeploymentAttestationProviderSnapshot;
}

export interface RailwayApplicationDeploymentAttestationEvaluation {
  readonly candidateSha: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly expiresAt: string;
  readonly checks: RailwayApplicationDeploymentAttestationChecks;
  readonly hashes: RailwayApplicationDeploymentAttestationReceipt["hashes"];
}

export interface RailwayApplicationDeploymentAttestationReceipt {
  readonly schemaVersion: typeof RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RECEIPT_SCHEMA_VERSION;
  readonly state: typeof RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RECEIPT_STATE;
  readonly candidateSha: string;
  readonly expectedEnvironment: typeof EXPECTED_ENVIRONMENT;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly expiresAt: string;
  readonly readOnlyEvidence: true;
  readonly activationAuthorized: false;
  readonly launchBlockerRemoved: false;
  readonly checks: RailwayApplicationDeploymentAttestationChecks;
  readonly hashes: {
    readonly policySha256: string;
    readonly projectIdSha256: string;
    readonly environmentIdSha256: string;
    readonly serviceInstanceIdSha256: string;
    readonly serviceIdSha256: string;
    readonly deploymentIdSha256: string;
    readonly snapshotIdSha256: string;
    readonly imageDigestSha256: string;
    readonly targetOriginSha256: string;
    readonly providerSnapshotSha256: string;
    readonly healthResponseSha256: string;
    readonly startupResponseSha256: string;
    readonly readyResponseSha256: string;
    readonly replicaIdSha256s: readonly [string];
  };
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || ARRAY_IS_ARRAY(value)) {
    return false;
  }
  const actual = REFLECT_APPLY(OBJECT_KEYS, OBJECT_CONSTRUCTOR, [value]) as string[];
  if (actual.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (
      actual[index] !== expected[index]
      || ownEnumerableDataDescriptor(value, expected[index]!) === null
    ) return false;
  }
  return true;
}

function ownEnumerableDataDescriptor(
  value: object,
  key: PropertyKey,
): PropertyDescriptor | null {
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [value, key],
  ) as PropertyDescriptor | undefined;
  return descriptor !== undefined
    && descriptor.enumerable === true
    && REFLECT_APPLY(
      OBJECT_HAS_OWN,
      OBJECT_CONSTRUCTOR,
      [descriptor, "value"],
    ) === true
    ? descriptor
    : null;
}

function defineOwnArrayElement<T>(
  target: T[],
  index: number,
  value: T,
): boolean {
  const previousLength = target.length;
  const key = jsonNumber(index);
  const defined = REFLECT_APPLY(
    REFLECT_DEFINE_PROPERTY,
    REFLECT_OBJECT,
    [target, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    }],
  );
  const descriptor = ownEnumerableDataDescriptor(target, key);
  const expectedLength = previousLength > index ? previousLength : index + 1;
  return defined === true
    && descriptor !== null
    && descriptor.value === value
    && target.length === expectedLength;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !ARRAY_IS_ARRAY(value);
}

function exactArrayValues(value: unknown, expected: readonly unknown[]): boolean {
  if (!ARRAY_IS_ARRAY(value) || value.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const descriptor = ownEnumerableDataDescriptor(value, `${index}`);
    if (descriptor === null || descriptor.value !== expected[index]) return false;
  }
  return true;
}

function parseBoundedJson(source: string, maximumBytes: number): unknown | null {
  const bytes = REFLECT_APPLY(
    BUFFER_BYTE_LENGTH,
    BUFFER_CONSTRUCTOR,
    [source, "utf8"],
  ) as number;
  if (
    bytes === 0
    || bytes > maximumBytes
    || REFLECT_APPLY(STRING_INCLUDES, source, ["\0"]) === true
  ) return null;
  try {
    return REFLECT_APPLY(JSON_PARSE, JSON_OBJECT, [source]) as unknown;
  } catch {
    return null;
  }
}

function exactBufferLength(value: Buffer): number | null {
  if (BUFFER_IS_BUFFER(value) !== true) return null;
  try {
    const length = REFLECT_APPLY(TYPED_ARRAY_LENGTH_GETTER, value, []) as unknown;
    return typeof length === "number"
      && NUMBER_IS_SAFE_INTEGER(length)
      && length >= 0
      ? length
      : null;
  } catch {
    return null;
  }
}

function copyReceiptBytes(source: string | Buffer): Buffer | null {
  try {
    let input: Uint8Array;
    if (typeof source === "string") {
      input = REFLECT_APPLY(TEXT_ENCODER_ENCODE, UTF8_ENCODER, [source]) as Uint8Array;
    } else {
      if (
        BUFFER_IS_BUFFER(source) !== true
        || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [source])
          !== BUFFER_PROTOTYPE
      ) return null;
      input = source;
    }
    const length = REFLECT_APPLY(
      TYPED_ARRAY_LENGTH_GETTER,
      input,
      [],
    ) as unknown;
    if (
      typeof length !== "number"
      || !NUMBER_IS_SAFE_INTEGER(length)
      || length < 0
      || length > RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_RECEIPT_BYTES
    ) return null;
    const output = REFLECT_APPLY(
      BUFFER_ALLOC,
      BUFFER_CONSTRUCTOR,
      [length],
    ) as Buffer;
    if (exactBufferLength(output) !== length) return null;
    REFLECT_APPLY(UINT8_ARRAY_SET, output, [input, 0]);
    return output;
  } catch {
    return null;
  }
}

function sha256(value: string | Buffer): string {
  const hash = REFLECT_APPLY(CRYPTO_CREATE_HASH, crypto, ["sha256"]);
  REFLECT_APPLY(HASH_UPDATE, hash, [value]);
  return REFLECT_APPLY(HASH_DIGEST, hash, ["hex"]) as string;
}

function domainSeparatedSha256(domain: string, value: string): string {
  const hash = REFLECT_APPLY(CRYPTO_CREATE_HASH, crypto, ["sha256"]);
  REFLECT_APPLY(HASH_UPDATE, hash, [`${domain}\0`, "utf8"]);
  REFLECT_APPLY(HASH_UPDATE, hash, [value, "utf8"]);
  return REFLECT_APPLY(HASH_DIGEST, hash, ["hex"]) as string;
}

function matches(pattern: RegExp, value: string): boolean {
  return REFLECT_APPLY(REGEXP_EXEC, pattern, [value]) !== null;
}

function exactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = REFLECT_APPLY(DATE_PARSE, DATE_CONSTRUCTOR, [value]) as number;
  if (!REFLECT_APPLY(NUMBER_IS_FINITE, NUMBER_CONSTRUCTOR, [timestamp])) return false;
  const date = new DATE_CONSTRUCTOR(timestamp);
  return REFLECT_APPLY(DATE_TO_ISO_STRING, date, []) === value;
}

function safeDomain(value: unknown, suffix: string): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 253
    || value !== REFLECT_APPLY(STRING_TO_LOWER_CASE, value, [])
    || REFLECT_APPLY(STRING_ENDS_WITH, value, [suffix]) !== true
    || matches(/[\r\n\0/:?#@\s]/, value)
  ) return false;
  try {
    const parsed = new NodeUrl(`https://${value}`);
    return REFLECT_APPLY(URL_HOSTNAME_GETTER, parsed, []) === value
      && REFLECT_APPLY(URL_ORIGIN_GETTER, parsed, []) === `https://${value}`;
  } catch {
    return false;
  }
}

function canonicalProviderSnapshot(
  value: RailwayApplicationDeploymentAttestationProviderSnapshot,
): string {
  let activeDeployments = "[";
  for (let index = 0; index < value.activeDeployments.length; index += 1) {
    const deployment = value.activeDeployments[index]!;
    if (index > 0) activeDeployments += ",";
    activeDeployments += `{"id":${jsonString(deployment.id)},"status":${jsonString(deployment.status)},"deploymentStopped":${jsonBoolean(deployment.deploymentStopped)}}`;
  }
  activeDeployments += "]";

  let domains = "[";
  for (let index = 0; index < value.domains.length; index += 1) {
    const domain = value.domains[index]!;
    if (index > 0) domains += ",";
    domains += `{"kind":${jsonString(domain.kind)},"id":${jsonString(domain.id)},"domain":${jsonString(domain.domain)},"targetPort":${domain.targetPort === null ? "null" : jsonNumber(domain.targetPort)}}`;
  }
  domains += "]";

  return `{"serviceInstanceId":${jsonString(value.serviceInstanceId)},"serviceId":${jsonString(value.serviceId)},"environmentId":${jsonString(value.environmentId)},"numReplicas":${jsonNumber(value.numReplicas)},"latestDeployment":{"id":${jsonString(value.latestDeployment.id)},"status":${jsonString(value.latestDeployment.status)},"deploymentStopped":${jsonBoolean(value.latestDeployment.deploymentStopped)},"snapshotId":${jsonString(value.latestDeployment.snapshotId)}},"activeDeployments":${activeDeployments},"domains":${domains},"deployment":{"id":${jsonString(value.deployment.id)},"projectId":${jsonString(value.deployment.projectId)},"environmentId":${jsonString(value.deployment.environmentId)},"serviceId":${jsonString(value.deployment.serviceId)},"snapshotId":${jsonString(value.deployment.snapshotId)},"commitHash":${jsonString(value.deployment.commitHash)},"imageDigest":${jsonString(value.deployment.imageDigest)},"patchId":${value.deployment.patchId === null ? "null" : jsonString(value.deployment.patchId)}}}`;
}

function jsonString(value: string): string {
  return REFLECT_APPLY(JSON_STRINGIFY, JSON_OBJECT, [value]) as string;
}

function jsonNumber(value: number): string {
  return REFLECT_APPLY(NUMBER_TO_STRING, value, []) as string;
}

function jsonBoolean(value: boolean): "true" | "false" {
  return value === true ? "true" : "false";
}

function parseDeploymentSummary(value: unknown): ProviderDeploymentSummary | null {
  if (
    !exactKeys(value, ["id", "status", "deploymentStopped"])
    || typeof value.id !== "string"
    || !matches(UUID_PATTERN, value.id)
    || typeof value.status !== "string"
    || !matches(/^[A-Z_]{1,32}$/, value.status)
    || typeof value.deploymentStopped !== "boolean"
  ) return null;
  return {
    id: value.id,
    status: value.status,
    deploymentStopped: value.deploymentStopped,
  };
}

function parseProviderDomain(
  value: unknown,
  kind: ProviderDomain["kind"],
): ProviderDomain | null {
  if (
    !exactKeys(value, ["id", "domain", "targetPort"])
    || typeof value.id !== "string"
    || !matches(UUID_PATTERN, value.id)
    || typeof value.domain !== "string"
    || value.domain.length === 0
    || value.domain.length > 253
    || value.domain !== REFLECT_APPLY(STRING_TO_LOWER_CASE, value.domain, [])
    || matches(/[\r\n\0/:?#@\s]/, value.domain)
    || !(value.targetPort === null
      || (REFLECT_APPLY(
        NUMBER_IS_SAFE_INTEGER,
        NUMBER_CONSTRUCTOR,
        [value.targetPort],
      ) === true
        && (value.targetPort as number) >= 1
        && (value.targetPort as number) <= 65_535))
  ) return null;
  return {
    kind,
    id: value.id,
    domain: value.domain,
    targetPort: value.targetPort as number | null,
  };
}

export function parseRailwayApplicationDeploymentAttestationPolicy(
  source: string,
): RailwayApplicationDeploymentAttestationPolicy | null {
  const value = parseBoundedJson(
    source,
    RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_POLICY_BYTES,
  );
  if (!exactKeys(value, [
    "schemaVersion",
    "policyId",
    "mode",
    "activationAuthorized",
    "launchBlockerRemoved",
    "graphqlEndpoint",
    "projectId",
    "stagingEnvironmentId",
    "serviceId",
    "forbiddenProduction",
    "allowedDomainSuffix",
    "runtimeRoutes",
    "limits",
  ])) return null;
  if (
    value.schemaVersion !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SCHEMA_VERSION
    || value.policyId !== POLICY_ID
    || value.mode !== "read-only-observation"
    || value.activationAuthorized !== false
    || value.launchBlockerRemoved !== false
    || value.graphqlEndpoint !== GRAPHQL_ENDPOINT
    || value.projectId
      !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK.projectId
    || value.stagingEnvironmentId
      !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK.stagingEnvironmentId
    || value.serviceId
      !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK.serviceId
    || !exactKeys(value.forbiddenProduction, ["environmentId", "serviceId"])
    || value.forbiddenProduction.environmentId
      !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK
        .forbiddenProductionEnvironmentId
    || value.forbiddenProduction.serviceId
      !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK
        .forbiddenProductionServiceId
    || value.allowedDomainSuffix !== ".up.railway.app"
    || !exactArrayValues(value.runtimeRoutes, RUNTIME_ROUTES)
    || !exactKeys(value.limits, [
      "maximumProviderResponseBytes",
      "maximumRuntimeResponseBytes",
      "maximumObservationSeconds",
      "maximumReceiptAgeSeconds",
    ])
    || value.limits.maximumProviderResponseBytes
      !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_PROVIDER_RESPONSE_BYTES
    || value.limits.maximumRuntimeResponseBytes
      !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_RUNTIME_RESPONSE_BYTES
    || value.limits.maximumObservationSeconds !== 120
    || value.limits.maximumReceiptAgeSeconds !== 900
  ) return null;
  return value as unknown as RailwayApplicationDeploymentAttestationPolicy;
}

export function parseRailwayApplicationDeploymentAttestationTokenScopeResponse(
  source: string,
): RailwayApplicationDeploymentAttestationTokenScope | null {
  const value = parseBoundedJson(
    source,
    RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_PROVIDER_RESPONSE_BYTES,
  );
  if (!exactKeys(value, ["data"]) || !exactKeys(value.data, ["projectToken"])) {
    return null;
  }
  const token = value.data.projectToken;
  if (
    !exactKeys(token, ["projectId", "environmentId"])
    || typeof token.projectId !== "string"
    || !matches(UUID_PATTERN, token.projectId)
    || typeof token.environmentId !== "string"
    || !matches(UUID_PATTERN, token.environmentId)
  ) return null;
  return { projectId: token.projectId, environmentId: token.environmentId };
}

export function parseRailwayApplicationDeploymentAttestationEmptyPatchResponse(
  source: string,
): RailwayApplicationDeploymentAttestationEmptyPatch | null {
  const value = parseBoundedJson(
    source,
    RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_PROVIDER_RESPONSE_BYTES,
  );
  if (!exactKeys(value, ["data"]) || !exactKeys(value.data, ["environment", "staged"])) {
    return null;
  }
  const environment = value.data.environment;
  const staged = value.data.staged;
  if (
    !exactKeys(environment, ["id"])
    || typeof environment.id !== "string"
    || !matches(UUID_PATTERN, environment.id)
    || !exactKeys(staged, ["environmentId", "patch"])
    || staged.environmentId !== environment.id
    || !plainObject(staged.patch)
    || (REFLECT_APPLY(
      OBJECT_KEYS,
      OBJECT_CONSTRUCTOR,
      [staged.patch],
    ) as string[]).length !== 0
  ) return null;
  return { environmentId: environment.id, patchEmpty: true };
}

export function parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse(
  source: string,
): RailwayApplicationDeploymentAttestationProviderSnapshot | null {
  const value = parseBoundedJson(
    source,
    RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_PROVIDER_RESPONSE_BYTES,
  );
  if (!exactKeys(value, ["data"]) || !exactKeys(value.data, ["serviceInstance", "deployment"])) {
    return null;
  }
  const instance = value.data.serviceInstance;
  const deployment = value.data.deployment;
  if (
    !exactKeys(instance, [
      "id",
      "serviceId",
      "environmentId",
      "numReplicas",
      "latestDeployment",
      "activeDeployments",
      "domains",
    ])
    || typeof instance.id !== "string"
    || !matches(UUID_PATTERN, instance.id)
    || typeof instance.serviceId !== "string"
    || !matches(UUID_PATTERN, instance.serviceId)
    || typeof instance.environmentId !== "string"
    || !matches(UUID_PATTERN, instance.environmentId)
    || REFLECT_APPLY(
      NUMBER_IS_SAFE_INTEGER,
      NUMBER_CONSTRUCTOR,
      [instance.numReplicas],
    ) !== true
    || (instance.numReplicas as number) < 0
    || (instance.numReplicas as number) > 50
    || !ARRAY_IS_ARRAY(instance.activeDeployments)
    || instance.activeDeployments.length > 100
    || !exactKeys(instance.domains, ["serviceDomains", "customDomains"])
    || !ARRAY_IS_ARRAY(instance.domains.serviceDomains)
    || !ARRAY_IS_ARRAY(instance.domains.customDomains)
    || instance.domains.serviceDomains.length > 100
    || instance.domains.customDomains.length > 100
  ) return null;

  if (
    !exactKeys(instance.latestDeployment, [
      "id",
      "status",
      "deploymentStopped",
      "snapshotId",
    ])
    || typeof instance.latestDeployment.id !== "string"
    || !matches(UUID_PATTERN, instance.latestDeployment.id)
    || typeof instance.latestDeployment.status !== "string"
    || !matches(/^[A-Z_]{1,32}$/, instance.latestDeployment.status)
    || typeof instance.latestDeployment.deploymentStopped !== "boolean"
    || typeof instance.latestDeployment.snapshotId !== "string"
    || !matches(UUID_PATTERN, instance.latestDeployment.snapshotId)
  ) return null;
  const latestDeployment: ProviderLatestDeployment = {
    id: instance.latestDeployment.id,
    status: instance.latestDeployment.status,
    deploymentStopped: instance.latestDeployment.deploymentStopped,
    snapshotId: instance.latestDeployment.snapshotId,
  };
  const activeDeployments: ProviderDeploymentSummary[] = [];
  for (let index = 0; index < instance.activeDeployments.length; index += 1) {
    const candidate = instance.activeDeployments[index];
    const parsed = parseDeploymentSummary(candidate);
    if (!parsed) return null;
    if (!defineOwnArrayElement(activeDeployments, index, parsed)) return null;
  }
  for (let left = 0; left < activeDeployments.length; left += 1) {
    for (let right = left + 1; right < activeDeployments.length; right += 1) {
      if (activeDeployments[left]!.id === activeDeployments[right]!.id) return null;
    }
  }
  const domains: ProviderDomain[] = [];
  let domainCount = 0;
  for (let index = 0; index < instance.domains.serviceDomains.length; index += 1) {
    const candidate = instance.domains.serviceDomains[index];
    const parsed = parseProviderDomain(candidate, "service");
    if (!parsed) return null;
    if (!defineOwnArrayElement(domains, domainCount, parsed)) return null;
    domainCount += 1;
  }
  for (let index = 0; index < instance.domains.customDomains.length; index += 1) {
    const candidate = instance.domains.customDomains[index];
    const parsed = parseProviderDomain(candidate, "custom");
    if (!parsed) return null;
    if (!defineOwnArrayElement(domains, domainCount, parsed)) return null;
    domainCount += 1;
  }
  for (let left = 0; left < domains.length; left += 1) {
    for (let right = left + 1; right < domains.length; right += 1) {
      if (
        domains[left]!.id === domains[right]!.id
        || domains[left]!.domain === domains[right]!.domain
      ) return null;
    }
  }

  if (
    !exactKeys(deployment, [
      "id",
      "projectId",
      "environmentId",
      "serviceId",
      "snapshotId",
      "meta",
    ])
    || typeof deployment.id !== "string"
    || !matches(UUID_PATTERN, deployment.id)
    || typeof deployment.projectId !== "string"
    || !matches(UUID_PATTERN, deployment.projectId)
    || typeof deployment.environmentId !== "string"
    || !matches(UUID_PATTERN, deployment.environmentId)
    || typeof deployment.serviceId !== "string"
    || !matches(UUID_PATTERN, deployment.serviceId)
    || typeof deployment.snapshotId !== "string"
    || !matches(UUID_PATTERN, deployment.snapshotId)
    || !plainObject(deployment.meta)
  ) return null;
  const commitHashDescriptor = ownEnumerableDataDescriptor(
    deployment.meta,
    "commitHash",
  );
  const imageDigestDescriptor = ownEnumerableDataDescriptor(
    deployment.meta,
    "imageDigest",
  );
  const patchIdDescriptor = ownEnumerableDataDescriptor(deployment.meta, "patchId");
  if (
    commitHashDescriptor === null
    || imageDigestDescriptor === null
    || patchIdDescriptor === null
  ) return null;
  const commitHash = commitHashDescriptor.value;
  const imageDigest = imageDigestDescriptor.value;
  const patchId = patchIdDescriptor.value;
  if (
    typeof commitHash !== "string"
    || !matches(CANDIDATE_PATTERN, commitHash)
    || typeof imageDigest !== "string"
    || !matches(IMAGE_DIGEST_PATTERN, imageDigest)
    || !(patchId === null || (typeof patchId === "string" && matches(UUID_PATTERN, patchId)))
  ) return null;

  return {
    serviceInstanceId: instance.id,
    serviceId: instance.serviceId,
    environmentId: instance.environmentId,
    numReplicas: instance.numReplicas as number,
    latestDeployment,
    activeDeployments,
    domains,
    deployment: {
      id: deployment.id,
      projectId: deployment.projectId,
      environmentId: deployment.environmentId,
      serviceId: deployment.serviceId,
      snapshotId: deployment.snapshotId,
      commitHash,
      imageDigest,
      patchId,
    },
  };
}

function exactReadyRestoreRehearsalState(value: unknown): boolean {
  if (
    !plainObject(value)
    || REFLECT_APPLY(
      OBJECT_GET_PROTOTYPE_OF,
      OBJECT_CONSTRUCTOR,
      [value],
    ) !== OBJECT_PROTOTYPE
    || !exactKeys(value, [
      "enabled",
      "externalWritesAllowed",
      "httpMutationRoutesAllowed",
      "runtimeDatabase",
      "remoteVenueDirectoryEnabled",
    ])
    || value.enabled !== false
    || value.externalWritesAllowed !== true
    || value.httpMutationRoutesAllowed !== true
    || value.runtimeDatabase !== "primary_runtime_database"
    || value.remoteVenueDirectoryEnabled !== true
  ) return false;
  const keys = REFLECT_APPLY(
    OBJECT_KEYS,
    OBJECT_CONSTRUCTOR,
    [value],
  ) as string[];
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      OBJECT_CONSTRUCTOR,
      [value, keys[index]],
    ) as PropertyDescriptor | undefined;
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || descriptor.configurable !== true
      || descriptor.writable !== true
    ) return false;
  }
  return true;
}

function containsDisallowedRestoreMarker(
  value: unknown,
  route: RuntimeRoute,
): boolean {
  const allowedDependencies = route === "/ready"
    && plainObject(value)
    && plainObject(value.data)
    && plainObject(value.data.dependencies)
    ? value.data.dependencies
    : null;
  const pending: unknown[] = [];
  if (!defineOwnArrayElement(pending, 0, value)) return true;
  let pendingLength = 1;
  let visited = 0;
  while (pendingLength > 0) {
    pendingLength -= 1;
    const candidate = pending[pendingLength];
    visited += 1;
    if (visited > 20_000) return true;
    if (ARRAY_IS_ARRAY(candidate)) {
      for (let index = 0; index < candidate.length; index += 1) {
        if (!defineOwnArrayElement(pending, pendingLength, candidate[index])) {
          return true;
        }
        pendingLength += 1;
      }
    } else if (plainObject(candidate)) {
      const keys = REFLECT_APPLY(
        OBJECT_KEYS,
        OBJECT_CONSTRUCTOR,
        [candidate],
      ) as string[];
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!;
        if (matches(RESTORE_MARKER_PATTERN, key)) {
          if (
            candidate !== allowedDependencies
            || key !== "restoreRehearsal"
            || !exactReadyRestoreRehearsalState(candidate[key])
          ) return true;
        }
        if (!defineOwnArrayElement(pending, pendingLength, candidate[key])) {
          return true;
        }
        pendingLength += 1;
      }
    }
  }
  return false;
}

export function parseRailwayApplicationDeploymentAttestationRuntimeResponse(
  route: RuntimeRoute,
  source: string,
): RailwayApplicationDeploymentAttestationRuntimeResponse | null {
  if (route !== "/health" && route !== "/startup" && route !== "/ready") return null;
  const value = parseBoundedJson(
    source,
    RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_RUNTIME_RESPONSE_BYTES,
  );
  if (
    !exactKeys(value, ["ok", "data"])
    || value.ok !== true
    || containsDisallowedRestoreMarker(value, route)
    || !plainObject(value.data)
  ) return null;
  const expectedDataKeys = route === "/health"
    ? ["service", "status", "deployment"]
    : ["service", "status", "deployment", "dependencies"];
  if (!exactKeys(value.data, expectedDataKeys)) return null;
  const expectedStatus = route === "/health"
    ? "ok"
    : route === "/startup"
      ? "startup_ready"
      : "ready";
  if (
    value.data.service !== "pint-path"
    || value.data.status !== expectedStatus
    || (route !== "/health" && !plainObject(value.data.dependencies))
  ) return null;
  const deployment = value.data.deployment;
  if (
    !exactKeys(deployment, [
      "version",
      "commitSha",
      "environment",
      "projectIdSha256",
      "environmentIdSha256",
      "serviceIdSha256",
      "deploymentIdSha256",
      "replicaIdSha256",
    ])
    || typeof deployment.version !== "string"
    || !matches(SAFE_VERSION_PATTERN, deployment.version)
    || typeof deployment.commitSha !== "string"
    || !matches(CANDIDATE_PATTERN, deployment.commitSha)
    || deployment.environment !== "production"
  ) return null;
  const deploymentHashes = [
    deployment.projectIdSha256,
    deployment.environmentIdSha256,
    deployment.serviceIdSha256,
    deployment.deploymentIdSha256,
    deployment.replicaIdSha256,
  ];
  for (let index = 0; index < deploymentHashes.length; index += 1) {
    const candidate = deploymentHashes[index];
    if (typeof candidate !== "string" || !matches(SHA256_PATTERN, candidate)) {
      return null;
    }
  }
  return {
    route,
    service: "pint-path",
    status: expectedStatus,
    deployment: deployment as unknown as RuntimeDeployment,
    restoreMarkerPresent: false,
    responseSha256: sha256(source),
  };
}

function exactOrigin(value: string, suffix: string): NodeUrl | null {
  try {
    const parsed = new NodeUrl(value);
    if (
      REFLECT_APPLY(URL_PROTOCOL_GETTER, parsed, []) !== "https:"
      || REFLECT_APPLY(URL_USERNAME_GETTER, parsed, []) !== ""
      || REFLECT_APPLY(URL_PASSWORD_GETTER, parsed, []) !== ""
      || REFLECT_APPLY(URL_PORT_GETTER, parsed, []) !== ""
      || REFLECT_APPLY(URL_PATHNAME_GETTER, parsed, []) !== "/"
      || REFLECT_APPLY(URL_SEARCH_GETTER, parsed, []) !== ""
      || REFLECT_APPLY(URL_HASH_GETTER, parsed, []) !== ""
      || REFLECT_APPLY(URL_ORIGIN_GETTER, parsed, []) !== value
      || !safeDomain(
        REFLECT_APPLY(URL_HOSTNAME_GETTER, parsed, []) as string,
        suffix,
      )
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function allTrueChecks(): RailwayApplicationDeploymentAttestationChecks {
  return OBJECT_FREEZE({
    policyExact: true,
    queriesReadOnly: true,
    tokenScopeExact: true,
    patchEmptyBefore: true,
    patchEmptyAfter: true,
    providerTargetExact: true,
    providerSnapshotStable: true,
    deploymentSuccessful: true,
    providerOriginAttached: true,
    candidateExact: true,
    runtimeRoutesExact: true,
    runtimeIdentityExact: true,
    singleReplicaExact: true,
    restoreStateAbsent: true,
    observationWindowBounded: true,
    readOnlyStateRetained: true,
  });
}

export function evaluateRailwayApplicationDeploymentAttestation(
  input: RailwayApplicationDeploymentAttestationEvaluationInput,
): RailwayApplicationDeploymentAttestationEvaluation | null {
  const { policy, providerBefore, providerAfter } = input;
  const startedMs = REFLECT_APPLY(DATE_PARSE, DATE_CONSTRUCTOR, [input.startedAt]) as number;
  const completedMs = REFLECT_APPLY(
    DATE_PARSE,
    DATE_CONSTRUCTOR,
    [input.completedAt],
  ) as number;
  const origin = exactOrigin(input.targetOrigin, policy.allowedDomainSuffix);
  if (
    policy.policyId !== POLICY_ID
    || policy.projectId
      !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK.projectId
    || policy.stagingEnvironmentId
      !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK.stagingEnvironmentId
    || policy.serviceId
      !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK.serviceId
    || policy.forbiddenProduction.environmentId
      !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK
        .forbiddenProductionEnvironmentId
    || policy.forbiddenProduction.serviceId
      !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK
        .forbiddenProductionServiceId
    || policy.activationAuthorized !== false
    || policy.launchBlockerRemoved !== false
    || input.policySha256 !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SHA256
    || !matches(CANDIDATE_PATTERN, input.candidateSha)
    || !exactIsoTimestamp(input.startedAt)
    || !exactIsoTimestamp(input.completedAt)
    || completedMs < startedMs
    || completedMs - startedMs > policy.limits.maximumObservationSeconds * 1_000
    || input.queriesReadOnly !== true
    || !origin
    || input.targetOriginSha256 !== sha256(input.targetOrigin)
    || input.tokenScope.projectId !== policy.projectId
    || input.tokenScope.environmentId !== policy.stagingEnvironmentId
    || input.patchBefore.environmentId !== policy.stagingEnvironmentId
    || input.patchAfter.environmentId !== policy.stagingEnvironmentId
    || input.patchBefore.patchEmpty !== true
    || input.patchAfter.patchEmpty !== true
    || canonicalProviderSnapshot(providerBefore)
      !== canonicalProviderSnapshot(providerAfter)
    || providerBefore.serviceId !== policy.serviceId
    || providerBefore.environmentId !== policy.stagingEnvironmentId
    || providerBefore.numReplicas !== 1
    || providerBefore.deployment.projectId !== policy.projectId
    || providerBefore.deployment.environmentId !== policy.stagingEnvironmentId
    || providerBefore.deployment.serviceId !== policy.serviceId
    || providerBefore.latestDeployment.id !== providerBefore.deployment.id
    || providerBefore.latestDeployment.snapshotId !== providerBefore.deployment.snapshotId
    || providerBefore.latestDeployment.status !== "SUCCESS"
    || providerBefore.latestDeployment.deploymentStopped !== false
    || providerBefore.activeDeployments.length !== 1
    || providerBefore.activeDeployments[0]?.id !== providerBefore.deployment.id
    || providerBefore.activeDeployments[0]?.status !== "SUCCESS"
    || providerBefore.activeDeployments[0]?.deploymentStopped !== false
    || providerBefore.deployment.commitHash !== input.candidateSha
    || providerBefore.deployment.patchId !== null
    || providerBefore.domains.length !== 1
    || providerBefore.domains[0]?.kind !== "service"
    || providerBefore.domains[0]?.domain
      !== REFLECT_APPLY(URL_HOSTNAME_GETTER, origin, [])
  ) return null;

  const expectedHashes = {
    projectIdSha256: railwayDeploymentIdentityIdSha256("project", policy.projectId),
    environmentIdSha256: railwayDeploymentIdentityIdSha256(
      "environment",
      policy.stagingEnvironmentId,
    ),
    serviceIdSha256: railwayDeploymentIdentityIdSha256("service", policy.serviceId),
    deploymentIdSha256: railwayDeploymentIdentityIdSha256(
      "deployment",
      providerBefore.deployment.id,
    ),
  };
  if (
    expectedHashes.projectIdSha256 === undefined
    || expectedHashes.environmentIdSha256 === undefined
    || expectedHashes.serviceIdSha256 === undefined
    || expectedHashes.deploymentIdSha256 === undefined
  ) return null;
  const runtime = [input.runtime.health, input.runtime.startup, input.runtime.ready];
  if (
    runtime[0]?.route !== "/health"
    || runtime[1]?.route !== "/startup"
    || runtime[2]?.route !== "/ready"
  ) return null;
  for (let index = 0; index < runtime.length; index += 1) {
    const response = runtime[index]!;
    if (
      response.restoreMarkerPresent !== false
      || response.deployment.commitSha !== input.candidateSha
      || response.deployment.environment !== "production"
      || response.deployment.projectIdSha256 !== expectedHashes.projectIdSha256
      || response.deployment.environmentIdSha256 !== expectedHashes.environmentIdSha256
      || response.deployment.serviceIdSha256 !== expectedHashes.serviceIdSha256
      || response.deployment.deploymentIdSha256 !== expectedHashes.deploymentIdSha256
    ) return null;
  }
  const replicaIdSha256 = runtime[0]!.deployment.replicaIdSha256;
  if (
    typeof replicaIdSha256 !== "string"
    || !matches(SHA256_PATTERN, replicaIdSha256)
    || runtime[1]!.deployment.replicaIdSha256 !== replicaIdSha256
    || runtime[2]!.deployment.replicaIdSha256 !== replicaIdSha256
  ) {
    return null;
  }
  const expiresDate = new DATE_CONSTRUCTOR(
    completedMs + policy.limits.maximumReceiptAgeSeconds * 1_000,
  );
  const expiresAt = REFLECT_APPLY(DATE_TO_ISO_STRING, expiresDate, []) as string;
  return {
    candidateSha: input.candidateSha,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    expiresAt,
    checks: allTrueChecks(),
    hashes: {
      policySha256: input.policySha256,
      projectIdSha256: expectedHashes.projectIdSha256!,
      environmentIdSha256: expectedHashes.environmentIdSha256!,
      serviceInstanceIdSha256: domainSeparatedSha256(
        "pintpath/railway-service-instance-evidence/v1",
        providerBefore.serviceInstanceId,
      ),
      serviceIdSha256: expectedHashes.serviceIdSha256!,
      deploymentIdSha256: expectedHashes.deploymentIdSha256!,
      snapshotIdSha256: domainSeparatedSha256(
        "pintpath/railway-snapshot-evidence/v1",
        providerBefore.deployment.snapshotId,
      ),
      imageDigestSha256: domainSeparatedSha256(
        "pintpath/railway-image-digest-evidence/v1",
        providerBefore.deployment.imageDigest,
      ),
      targetOriginSha256: input.targetOriginSha256,
      providerSnapshotSha256: sha256(canonicalProviderSnapshot(providerBefore)),
      healthResponseSha256: input.runtime.health.responseSha256,
      startupResponseSha256: input.runtime.startup.responseSha256,
      readyResponseSha256: input.runtime.ready.responseSha256,
      replicaIdSha256s: [replicaIdSha256],
    },
  };
}

export function buildRailwayApplicationDeploymentAttestationReceipt(
  evaluation: RailwayApplicationDeploymentAttestationEvaluation,
): RailwayApplicationDeploymentAttestationReceipt {
  return OBJECT_FREEZE({
    schemaVersion: RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RECEIPT_SCHEMA_VERSION,
    state: RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RECEIPT_STATE,
    candidateSha: evaluation.candidateSha,
    expectedEnvironment: EXPECTED_ENVIRONMENT,
    startedAt: evaluation.startedAt,
    completedAt: evaluation.completedAt,
    expiresAt: evaluation.expiresAt,
    readOnlyEvidence: true,
    activationAuthorized: false,
    launchBlockerRemoved: false,
    checks: evaluation.checks,
    hashes: evaluation.hashes,
  });
}

export function canonicalRailwayApplicationDeploymentAttestationReceipt(
  receipt: RailwayApplicationDeploymentAttestationReceipt,
): string {
  let checks = "{";
  for (let index = 0; index < CHECK_KEYS.length; index += 1) {
    const key = CHECK_KEYS[index]!;
    if (index > 0) checks += ",";
    checks += `${jsonString(key)}:${jsonBoolean(receipt.checks[key] === true)}`;
  }
  checks += "}";

  const hashes = receipt.hashes;
  const canonicalHashes = `{"policySha256":${jsonString(hashes.policySha256)},"projectIdSha256":${jsonString(hashes.projectIdSha256)},"environmentIdSha256":${jsonString(hashes.environmentIdSha256)},"serviceInstanceIdSha256":${jsonString(hashes.serviceInstanceIdSha256)},"serviceIdSha256":${jsonString(hashes.serviceIdSha256)},"deploymentIdSha256":${jsonString(hashes.deploymentIdSha256)},"snapshotIdSha256":${jsonString(hashes.snapshotIdSha256)},"imageDigestSha256":${jsonString(hashes.imageDigestSha256)},"targetOriginSha256":${jsonString(hashes.targetOriginSha256)},"providerSnapshotSha256":${jsonString(hashes.providerSnapshotSha256)},"healthResponseSha256":${jsonString(hashes.healthResponseSha256)},"startupResponseSha256":${jsonString(hashes.startupResponseSha256)},"readyResponseSha256":${jsonString(hashes.readyResponseSha256)},"replicaIdSha256s":[${jsonString(hashes.replicaIdSha256s[0])}]}`;

  return `{"schemaVersion":${jsonString(receipt.schemaVersion)},"state":${jsonString(receipt.state)},"candidateSha":${jsonString(receipt.candidateSha)},"expectedEnvironment":${jsonString(receipt.expectedEnvironment)},"startedAt":${jsonString(receipt.startedAt)},"completedAt":${jsonString(receipt.completedAt)},"expiresAt":${jsonString(receipt.expiresAt)},"readOnlyEvidence":${jsonBoolean(receipt.readOnlyEvidence)},"activationAuthorized":${jsonBoolean(receipt.activationAuthorized)},"launchBlockerRemoved":${jsonBoolean(receipt.launchBlockerRemoved)},"checks":${checks},"hashes":${canonicalHashes}}\n`;
}

function parseReceiptObject(value: unknown): RailwayApplicationDeploymentAttestationReceipt | null {
  if (!exactKeys(value, [
    "schemaVersion",
    "state",
    "candidateSha",
    "expectedEnvironment",
    "startedAt",
    "completedAt",
    "expiresAt",
    "readOnlyEvidence",
    "activationAuthorized",
    "launchBlockerRemoved",
    "checks",
    "hashes",
  ])) return null;
  if (
    value.schemaVersion !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RECEIPT_SCHEMA_VERSION
    || value.state !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RECEIPT_STATE
    || typeof value.candidateSha !== "string"
    || !matches(CANDIDATE_PATTERN, value.candidateSha)
    || value.expectedEnvironment !== EXPECTED_ENVIRONMENT
    || !exactIsoTimestamp(value.startedAt)
    || !exactIsoTimestamp(value.completedAt)
    || !exactIsoTimestamp(value.expiresAt)
    || value.readOnlyEvidence !== true
    || value.activationAuthorized !== false
    || value.launchBlockerRemoved !== false
  ) return null;
  if (!exactKeys(value.checks, CHECK_KEYS)) return null;
  const checks = value.checks;
  for (let index = 0; index < CHECK_KEYS.length; index += 1) {
    if (checks[CHECK_KEYS[index]!] !== true) return null;
  }
  if (!exactKeys(value.hashes, RECEIPT_HASH_KEYS)) return null;
  const hashes = value.hashes;
  for (let index = 0; index < RECEIPT_HASH_KEYS.length - 1; index += 1) {
    const candidate = hashes[RECEIPT_HASH_KEYS[index]!];
    if (typeof candidate !== "string" || !matches(SHA256_PATTERN, candidate)) {
      return null;
    }
  }
  const replicaIdSha256Descriptor = ARRAY_IS_ARRAY(hashes.replicaIdSha256s)
    ? ownEnumerableDataDescriptor(hashes.replicaIdSha256s, "0")
    : null;
  if (
    hashes.policySha256 !== RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SHA256
    || !ARRAY_IS_ARRAY(hashes.replicaIdSha256s)
    || hashes.replicaIdSha256s.length !== 1
    || replicaIdSha256Descriptor === null
    || typeof replicaIdSha256Descriptor.value !== "string"
    || !matches(SHA256_PATTERN, replicaIdSha256Descriptor.value)
  ) return null;
  const started = REFLECT_APPLY(DATE_PARSE, DATE_CONSTRUCTOR, [value.startedAt]) as number;
  const completed = REFLECT_APPLY(
    DATE_PARSE,
    DATE_CONSTRUCTOR,
    [value.completedAt],
  ) as number;
  const expires = REFLECT_APPLY(DATE_PARSE, DATE_CONSTRUCTOR, [value.expiresAt]) as number;
  if (
    completed < started
    || completed - started > 120_000
    || expires !== completed + 900_000
  ) return null;
  return value as unknown as RailwayApplicationDeploymentAttestationReceipt;
}

export function parseRailwayApplicationDeploymentAttestationReceipt(
  source: string | Buffer,
): RailwayApplicationDeploymentAttestationReceipt | null {
  const bytes = copyReceiptBytes(source);
  if (bytes === null) return null;
  const byteLength = exactBufferLength(bytes);
  if (
    byteLength === null
    || byteLength === 0
    || byteLength > RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_RECEIPT_BYTES
  ) return null;
  let text: string;
  try {
    text = REFLECT_APPLY(TEXT_DECODER_DECODE, UTF8_FATAL_DECODER, [bytes]) as string;
  } catch {
    return null;
  }
  const parsed = parseBoundedJson(
    text,
    RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_RECEIPT_BYTES,
  );
  const receipt = parseReceiptObject(parsed);
  if (!receipt) return null;
  const canonicalBytes = copyReceiptBytes(
    canonicalRailwayApplicationDeploymentAttestationReceipt(receipt),
  );
  if (canonicalBytes === null) return null;
  const canonicalByteLength = exactBufferLength(canonicalBytes);
  if (
    canonicalByteLength === null
    || canonicalByteLength !== byteLength
    || REFLECT_APPLY(CRYPTO_TIMING_SAFE_EQUAL, crypto, [canonicalBytes, bytes]) !== true
  ) {
    return null;
  }
  return receipt;
}

export function railwayApplicationDeploymentAttestationReceiptFreshAt(
  receipt: RailwayApplicationDeploymentAttestationReceipt,
  now: Date,
): boolean {
  if (parseReceiptObject(receipt) === null) return false;
  let nowMs = 0 / 0;
  try {
    nowMs = REFLECT_APPLY(DATE_GET_TIME, now, []) as number;
  } catch {
    return false;
  }
  const startedMs = REFLECT_APPLY(DATE_PARSE, DATE_CONSTRUCTOR, [receipt.startedAt]) as number;
  const completedMs = REFLECT_APPLY(
    DATE_PARSE,
    DATE_CONSTRUCTOR,
    [receipt.completedAt],
  ) as number;
  const expiresMs = REFLECT_APPLY(DATE_PARSE, DATE_CONSTRUCTOR, [receipt.expiresAt]) as number;
  return REFLECT_APPLY(NUMBER_IS_FINITE, NUMBER_CONSTRUCTOR, [nowMs]) === true
    && exactIsoTimestamp(receipt.startedAt)
    && exactIsoTimestamp(receipt.completedAt)
    && exactIsoTimestamp(receipt.expiresAt)
    && completedMs >= startedMs
    && completedMs - startedMs <= 120_000
    && expiresMs === completedMs + 900_000
    && nowMs >= completedMs
    && nowMs <= expiresMs;
}

export function sha256RailwayApplicationDeploymentAttestationReceipt(
  receipt: RailwayApplicationDeploymentAttestationReceipt,
): string {
  return sha256(canonicalRailwayApplicationDeploymentAttestationReceipt(receipt));
}
