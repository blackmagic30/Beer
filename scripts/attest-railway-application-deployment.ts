import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder, types as utilTypes } from "node:util";
import { fileURLToPath } from "node:url";

import {
  RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_PROVIDER_RESPONSE_BYTES,
  RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_RECEIPT_BYTES,
  RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_RUNTIME_RESPONSE_BYTES,
  buildRailwayApplicationDeploymentAttestationReceipt,
  canonicalRailwayApplicationDeploymentAttestationReceipt,
  evaluateRailwayApplicationDeploymentAttestation,
  parseRailwayApplicationDeploymentAttestationEmptyPatchResponse,
  parseRailwayApplicationDeploymentAttestationPolicy,
  parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse,
  parseRailwayApplicationDeploymentAttestationRuntimeResponse,
  parseRailwayApplicationDeploymentAttestationTokenScopeResponse,
} from "../src/lib/railway-application-deployment-attestation.js";
import { RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RUNTIME } from
  "./lib/railway-application-deployment-attestation-runtime.js";
import { assertLockedSensitiveWorkerBoundary } from
  "./lib/locked-sensitive-worker-boundary.js";

export const RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_COMMAND =
  "attest" as const;

export const RAILWAY_APPLICATION_DEPLOYMENT_TOKEN_SCOPE_QUERY =
  `query PintPathRailwayApplicationDeploymentTokenScope {
  projectToken {
    projectId
    environmentId
  }
}` as const;

export const RAILWAY_APPLICATION_DEPLOYMENT_EMPTY_PATCH_QUERY =
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

export const RAILWAY_APPLICATION_DEPLOYMENT_DISCOVERY_QUERY =
  `query PintPathRailwayApplicationDeploymentDiscovery(
  $environmentId: String!
  $serviceId: String!
) {
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    latestDeployment { id }
  }
}` as const;

export const RAILWAY_APPLICATION_DEPLOYMENT_SNAPSHOT_QUERY =
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

const GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const STAGING_TOKEN_NAME = "PINTPATH_RAILWAY_STAGING_METADATA_TOKEN";
const POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../ops/railway/permanent-staging-app-deployment-attestation-policy.json",
);
const ARGUMENT_COUNT = 4;
const CANDIDATE_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PATH_BYTES = 4_096;
const REQUEST_TIMEOUT_MS = 15_000;
const FORBIDDEN_AMBIENT_AUTHORITY = Object.freeze([
  "ALL_PROXY",
  "DEBUG",
  "DEBUG_FD",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "NODE_USE_SYSTEM_CA",
  "NO_PROXY",
  "OPENSSL_CONF",
  "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN",
  "PINTPATH_RAILWAY_METADATA_TOKEN",
  "RAILWAY_API_TOKEN",
  "RAILWAY_TOKEN",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const);

const ABORT_SIGNAL = AbortSignal;
const ABORT_SIGNAL_PROTOTYPE = AbortSignal.prototype;
const ABORT_SIGNAL_TIMEOUT = AbortSignal.timeout;
const ARRAY_CONSTRUCTOR = Array;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_SLICE = Array.prototype.slice;
const BIGINT_CONSTRUCTOR = BigInt;
const BUFFER = Buffer;
const BUFFER_ALLOC = Buffer.alloc;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BUFFER_FROM = Buffer.from;
const BUFFER_IS_BUFFER = Buffer.isBuffer;
const BUFFER_PROTOTYPE = Buffer.prototype;
const CRYPTO_OBJECT = crypto;
const CRYPTO_CREATE_HASH = crypto.createHash;
const DATE_GET_TIME = Date.prototype.getTime;
const DATE_TO_ISO_STRING = Date.prototype.toISOString;
const HEADERS_PROTOTYPE = Headers.prototype;
const HEADERS_GET = Headers.prototype.get;
const JSON_OBJECT = JSON;
const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;
const NUMBER_CONSTRUCTOR = Number;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_INTEGER = Number.isInteger;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const NUMBER_TO_STRING = Number.prototype.toString;
const OBJECT_CREATE = Object.create;
const OBJECT_CONSTRUCTOR = Object;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_KEYS = Object.keys;
const OBJECT_PROTOTYPE = Object.prototype;
const PATH_OBJECT = path;
const PATH_DIRNAME = path.dirname;
const PATH_IS_ABSOLUTE = path.isAbsolute;
const PATH_JOIN = path.join;
const PATH_NORMALIZE = path.normalize;
const PATH_PARSE = path.parse;
const PATH_RESOLVE = path.resolve;
const PROCESS_ENV_PROTOTYPE = Object.getPrototypeOf(process.env) as object;
const PROCESS_GETEUID = process.geteuid;
const PROCESS_OBJECT = process;
const READABLE_STREAM_PROTOTYPE = ReadableStream.prototype;
const READABLE_STREAM_CANCEL = ReadableStream.prototype.cancel;
const READABLE_STREAM_GET_READER = ReadableStream.prototype.getReader;
const READER_PROTOTYPE = ReadableStreamDefaultReader.prototype;
const READER_CANCEL = ReadableStreamDefaultReader.prototype.cancel;
const READER_READ = ReadableStreamDefaultReader.prototype.read;
const READER_RELEASE_LOCK = ReadableStreamDefaultReader.prototype.releaseLock;
const REFLECT_APPLY = Reflect.apply;
const REGEXP_EXEC = RegExp.prototype.exec;
const RESPONSE_PROTOTYPE = Response.prototype;
const RESPONSE_BODY_GETTER = Object.getOwnPropertyDescriptor(
  Response.prototype,
  "body",
)?.get;
const RESPONSE_HEADERS_GETTER = Object.getOwnPropertyDescriptor(
  Response.prototype,
  "headers",
)?.get;
const RESPONSE_OK_GETTER = Object.getOwnPropertyDescriptor(
  Response.prototype,
  "ok",
)?.get;
const RESPONSE_STATUS_GETTER = Object.getOwnPropertyDescriptor(
  Response.prototype,
  "status",
)?.get;
const STRING_ENDS_WITH = String.prototype.endsWith;
const STRING_INCLUDES = String.prototype.includes;
const STRING_INDEX_OF = String.prototype.indexOf;
const STRING_SLICE = String.prototype.slice;
const STRING_STARTS_WITH = String.prototype.startsWith;
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const STRING_TRIM = String.prototype.trim;
const TEXT_DECODER = TextDecoder;
const TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const UINT8_ARRAY = Uint8Array;
const UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const URL_CONSTRUCTOR = URL;
const URL_PROTOTYPE = URL.prototype;
const URL_HASH_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "hash")?.get;
const URL_HOSTNAME_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "hostname")?.get;
const URL_ORIGIN_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "origin")?.get;
const URL_PASSWORD_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "password")?.get;
const URL_PATHNAME_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "pathname")?.get;
const URL_PORT_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "port")?.get;
const URL_PROTOCOL_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "protocol")?.get;
const URL_SEARCH_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "search")?.get;
const URL_USERNAME_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "username")?.get;
const UTIL_IS_DATE = utilTypes.isDate;
const UTIL_IS_PROXY = utilTypes.isProxy;
const UTIL_TYPES_OBJECT = utilTypes;

const FS_OBJECT = fs;
const FS_CLOSE_SYNC = fs.closeSync;
const FS_FCHMOD_SYNC = fs.fchmodSync;
const FS_FSTAT_SYNC = fs.fstatSync;
const FS_FSYNC_SYNC = fs.fsyncSync;
const FS_FTRUNCATE_SYNC = fs.ftruncateSync;
const FS_LINK_SYNC = fs.linkSync;
const FS_LSTAT_SYNC = fs.lstatSync;
const FS_OPEN_SYNC = fs.openSync;
const FS_READ_FILE_SYNC = fs.readFileSync;
const FS_READ_SYNC = fs.readSync;
const FS_REALPATH_SYNC = fs.realpathSync;
const FS_UNLINK_SYNC = fs.unlinkSync;
const FS_WRITE_SYNC = fs.writeSync;
const O_CREAT = fs.constants.O_CREAT;
const O_DIRECTORY = fs.constants.O_DIRECTORY;
const O_EXCL = fs.constants.O_EXCL;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW;
const O_RDONLY = fs.constants.O_RDONLY;
const O_RDWR = fs.constants.O_RDWR;
const S_IFDIR = 0o040000n;
const S_IFMT = 0o170000n;
const S_IFREG = 0o100000n;

const BIGINT_STAT_OPTIONS = OBJECT_FREEZE({ bigint: true } as const);
const TEXT_DECODER_OPTIONS = OBJECT_FREEZE({ fatal: true } as const);
const BIGINT_STATS_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(REFLECT_APPLY(
  FS_LSTAT_SYNC,
  FS_OBJECT,
  [fileURLToPath(import.meta.url), BIGINT_STAT_OPTIONS],
)) as object;
const HASH_PROBE = REFLECT_APPLY(CRYPTO_CREATE_HASH, CRYPTO_OBJECT, ["sha256"]);
const HASH_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(HASH_PROBE) as {
  update: (...input: never[]) => unknown;
  digest: (...input: never[]) => unknown;
};
const HASH_UPDATE = HASH_PROTOTYPE.update;
const HASH_DIGEST = HASH_PROTOTYPE.digest;
REFLECT_APPLY(HASH_DIGEST, HASH_PROBE, []);

const HEX_DIGITS = "0123456789abcdef";
const SAFE_ERROR_CODES = OBJECT_FREEZE([
  "argument_invalid",
  "policy_invalid",
  "environment_not_allowed",
  "token_invalid",
  "metadata_query_failed",
  "runtime_probe_failed",
  "attestation_failed",
  "output_file_unsafe",
  "unexpected_failure",
] as const);
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;|$)/i;
const CACHE_NO_STORE_PATTERN = /(?:^|,)\s*no-store\s*(?:,|$)/i;
const CONTROL_CHARACTER_PATTERN = /[\r\n\0]/;
const DIGITS_PATTERN = /^\d+$/;
const QUERY_DECRYPT_PATTERN = /decryptVariables\s*:\s*true/;
const QUERY_LOGS_PATTERN = /\blogs\b/i;
const QUERY_MUTATION_PATTERN = /\bmutation\s+/i;
const QUERY_VARIABLES_PATTERN = /\bvariables\s*\(/i;

type FailureCode =
  | "argument_invalid"
  | "policy_invalid"
  | "environment_not_allowed"
  | "token_invalid"
  | "metadata_query_failed"
  | "runtime_probe_failed"
  | "attestation_failed"
  | "output_file_unsafe"
  | "unexpected_failure";

class SafeAttestationError extends Error {
  readonly #code: FailureCode;

  constructor(code: FailureCode) {
    super(code);
    this.#code = code;
  }

  fixedCode(): FailureCode {
    return this.#code;
  }
}
const SAFE_ERROR_FIXED_CODE = SafeAttestationError.prototype.fixedCode;

class OpaqueAttestationFailure extends Error {
  constructor() {
    super("attestation_internal_failure");
  }
}

function opaqueFailure(): never {
  throw new OpaqueAttestationFailure();
}

interface RuntimeDependencies {
  readonly assertProductionBoundary?: () => void;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl: typeof fetch;
  readonly now: () => Date;
  readonly randomBytes: (size: number) => Buffer;
  readonly writeOutput: (value: string) => void;
}

interface PublishedReceipt {
  readonly sha256: string;
  reassert(): Promise<void>;
  release(): Promise<void>;
  rollback(): Promise<void>;
}

function fail(code: FailureCode): never {
  throw new SafeAttestationError(code);
}

function safeErrorCode(error: unknown): FailureCode | undefined {
  if (typeof error !== "object" || error === null || isProxy(error)) return undefined;
  try {
    const code = REFLECT_APPLY(SAFE_ERROR_FIXED_CODE, error, []) as unknown;
    if (typeof code !== "string") return undefined;
    for (let index = 0; index < SAFE_ERROR_CODES.length; index += 1) {
      if (SAFE_ERROR_CODES[index] === code) return code;
    }
  } catch {
    // Only the class private brand is accepted.
  }
  return undefined;
}

function isProxy(value: unknown): boolean {
  return REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_OBJECT, [value]) as boolean;
}

function regexMatches(pattern: RegExp, value: string): boolean {
  return REFLECT_APPLY(REGEXP_EXEC, pattern, [value]) !== null;
}

function descriptorDataValue(descriptor: PropertyDescriptor | undefined): {
  readonly found: boolean;
  readonly value?: unknown;
} {
  if (descriptor === undefined) return { found: false };
  if (
    isProxy(descriptor)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [descriptor])
      !== OBJECT_PROTOTYPE
  ) return { found: false };
  const valueDescriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [descriptor, "value"],
  ) as PropertyDescriptor | undefined;
  const getDescriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [descriptor, "get"],
  ) as PropertyDescriptor | undefined;
  const setDescriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [descriptor, "set"],
  ) as PropertyDescriptor | undefined;
  if (valueDescriptor === undefined || getDescriptor !== undefined || setDescriptor !== undefined) {
    return { found: false };
  }
  return { found: true, value: (valueDescriptor as { value: unknown }).value };
}

function ownData(value: object, key: PropertyKey): unknown | undefined {
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [value, key],
  ) as PropertyDescriptor | undefined;
  const data = descriptorDataValue(descriptor);
  if (!data.found) {
    if (descriptor === undefined) return undefined;
    fail("unexpected_failure");
  }
  return data.value;
}

function errnoIs(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || isProxy(error)) return false;
  try {
    return ownData(error, "code") === code;
  } catch {
    return false;
  }
}

function sha256(value: string | Uint8Array): string {
  const hash = REFLECT_APPLY(CRYPTO_CREATE_HASH, CRYPTO_OBJECT, ["sha256"]);
  if (isProxy(hash) || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [hash]) !== HASH_PROTOTYPE) {
    return fail("unexpected_failure");
  }
  REFLECT_APPLY(HASH_UPDATE, hash, [value]);
  const digest = REFLECT_APPLY(HASH_DIGEST, hash, ["hex"]) as unknown;
  if (typeof digest !== "string" || digest.length !== 64) {
    return fail("unexpected_failure");
  }
  for (let index = 0; index < digest.length; index += 1) {
    const character = digest[index];
    if (character === undefined || !REFLECT_APPLY(STRING_INCLUDES, HEX_DIGITS, [character])) {
      return fail("unexpected_failure");
    }
  }
  return digest;
}

function exactCandidateSha(value: string): string {
  if (!regexMatches(CANDIDATE_PATTERN, value)) fail("argument_invalid");
  return value;
}

function exactSha256(value: string): string {
  if (!regexMatches(SHA256_PATTERN, value)) fail("argument_invalid");
  return value;
}

function pathCall(method: (...input: never[]) => unknown, input: readonly unknown[]): string {
  const result = REFLECT_APPLY(method, PATH_OBJECT, input as never[]) as unknown;
  if (typeof result !== "string") return fail("unexpected_failure");
  return result;
}

function pathDirname(value: string): string {
  return pathCall(PATH_DIRNAME, [value]);
}

function pathResolve(value: string): string {
  return pathCall(PATH_RESOLVE, [value]);
}

function exactAbsolutePath(value: string): string {
  const absolute = REFLECT_APPLY(PATH_IS_ABSOLUTE, PATH_OBJECT, [value]) as unknown;
  const normalized = pathCall(PATH_NORMALIZE, [value]);
  const resolved = pathResolve(value);
  const parsed = REFLECT_APPLY(PATH_PARSE, PATH_OBJECT, [value]) as unknown;
  if (
    typeof parsed !== "object"
    || parsed === null
    || isProxy(parsed)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [parsed]) !== OBJECT_PROTOTYPE
  ) fail("argument_invalid");
  const root = ownData(parsed as object, "root");
  if (
    absolute !== true
    || normalized !== value
    || resolved !== value
    || typeof root !== "string"
    || value === root
    || REFLECT_APPLY(STRING_INCLUDES, value, ["\0"])
    || regexMatches(CONTROL_CHARACTER_PATTERN, value)
    || REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER, [value, "utf8"]) > MAX_PATH_BYTES
  ) fail("argument_invalid");
  return value;
}

function exactTargetOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL_CONSTRUCTOR(value);
  } catch {
    return fail("argument_invalid");
  }
  if (
    isProxy(parsed)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [parsed]) !== URL_PROTOTYPE
    || typeof URL_PROTOCOL_GETTER !== "function"
    || typeof URL_USERNAME_GETTER !== "function"
    || typeof URL_PASSWORD_GETTER !== "function"
    || typeof URL_PORT_GETTER !== "function"
    || typeof URL_PATHNAME_GETTER !== "function"
    || typeof URL_SEARCH_GETTER !== "function"
    || typeof URL_HASH_GETTER !== "function"
    || typeof URL_ORIGIN_GETTER !== "function"
    || typeof URL_HOSTNAME_GETTER !== "function"
  ) return fail("argument_invalid");
  const protocol = REFLECT_APPLY(URL_PROTOCOL_GETTER, parsed, []) as unknown;
  const username = REFLECT_APPLY(URL_USERNAME_GETTER, parsed, []) as unknown;
  const password = REFLECT_APPLY(URL_PASSWORD_GETTER, parsed, []) as unknown;
  const port = REFLECT_APPLY(URL_PORT_GETTER, parsed, []) as unknown;
  const pathname = REFLECT_APPLY(URL_PATHNAME_GETTER, parsed, []) as unknown;
  const search = REFLECT_APPLY(URL_SEARCH_GETTER, parsed, []) as unknown;
  const hash = REFLECT_APPLY(URL_HASH_GETTER, parsed, []) as unknown;
  const origin = REFLECT_APPLY(URL_ORIGIN_GETTER, parsed, []) as unknown;
  const hostname = REFLECT_APPLY(URL_HOSTNAME_GETTER, parsed, []) as unknown;
  if (
    protocol !== "https:"
    || username !== ""
    || password !== ""
    || port !== ""
    || pathname !== "/"
    || search !== ""
    || hash !== ""
    || origin !== value
    || typeof hostname !== "string"
    || hostname !== REFLECT_APPLY(STRING_TO_LOWER_CASE, hostname, [])
    || !REFLECT_APPLY(STRING_ENDS_WITH, hostname, [".up.railway.app"])
    || hostname.length > 253
  ) fail("argument_invalid");
  return origin;
}

function validToken(value: string | undefined): value is string {
  return typeof value === "string"
    && value.length >= 16
    && value.length <= 4_096
    && value === REFLECT_APPLY(STRING_TRIM, value, [])
    && !regexMatches(CONTROL_CHARACTER_PATTERN, value);
}

function exactEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  if (isProxy(environment)) fail("environment_not_allowed");
  const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [environment]);
  if (prototype !== OBJECT_PROTOTYPE && prototype !== PROCESS_ENV_PROTOTYPE) {
    fail("environment_not_allowed");
  }
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [environment, name],
  ) as PropertyDescriptor | undefined;
  const data = descriptorDataValue(descriptor);
  if (!data.found) {
    if (descriptor === undefined) return undefined;
    fail("environment_not_allowed");
  }
  if (data.value !== undefined && typeof data.value !== "string") {
    fail("environment_not_allowed");
  }
  return data.value as string | undefined;
}

function assertNoForbiddenAmbientAuthority(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  for (let index = 0; index < FORBIDDEN_AMBIENT_AUTHORITY.length; index += 1) {
    const name = FORBIDDEN_AMBIENT_AUTHORITY[index]!;
    const value = exactEnvironmentValue(environment, name);
    if (value !== undefined && value !== "") {
      fail("environment_not_allowed");
    }
  }
}

function assertEnvironmentExact(
  environment: Readonly<Record<string, string | undefined>>,
  token: string,
): void {
  assertNoForbiddenAmbientAuthority(environment);
  if (exactEnvironmentValue(environment, STAGING_TOKEN_NAME) !== token) {
    fail("environment_not_allowed");
  }
}

function exactDate(value: unknown): Date {
  if (
    !REFLECT_APPLY(UTIL_IS_DATE, UTIL_TYPES_OBJECT, [value])
    || isProxy(value)
    || !REFLECT_APPLY(NUMBER_IS_FINITE, NUMBER_CONSTRUCTOR, [
      REFLECT_APPLY(DATE_GET_TIME, value, []) as number,
    ])
  ) {
    return fail("unexpected_failure");
  }
  return value as Date;
}

function exactDateIso(value: Date): string {
  try {
    const result = REFLECT_APPLY(DATE_TO_ISO_STRING, value, []) as unknown;
    if (typeof result !== "string") return fail("unexpected_failure");
    return result;
  } catch {
    return fail("unexpected_failure");
  }
}

function jsonString(value: string): string {
  const encoded = REFLECT_APPLY(JSON_STRINGIFY, JSON_OBJECT, [value]) as unknown;
  if (typeof encoded !== "string") return fail("unexpected_failure");
  return encoded;
}

function graphqlBody(
  operationName: string,
  query: string,
  variablesJson: string,
): string {
  return `{"operationName":${jsonString(operationName)},"query":${jsonString(query)},"variables":${variablesJson}}`;
}

function twoVariablesJson(
  firstName: string,
  firstValue: string,
  secondName: string,
  secondValue: string,
): string {
  return `{${jsonString(firstName)}:${jsonString(firstValue)},${jsonString(secondName)}:${jsonString(secondValue)}}`;
}

function threeVariablesJson(
  environmentId: string,
  serviceId: string,
  deploymentId: string,
): string {
  return `{"environmentId":${jsonString(environmentId)},"serviceId":${jsonString(serviceId)},"deploymentId":${jsonString(deploymentId)}}`;
}

function exactRandomHex(random: Buffer): string {
  if (
    !REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER, [random])
    || isProxy(random)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [random]) !== BUFFER_PROTOTYPE
    || typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function"
    || REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH_GETTER, random, []) !== 16
  ) fail("output_file_unsafe");
  let result = "";
  try {
    for (let index = 0; index < 16; index += 1) {
      const byte = random[index];
      if (byte === undefined) fail("output_file_unsafe");
      result += HEX_DIGITS[(byte >>> 4) & 0x0f]! + HEX_DIGITS[byte & 0x0f]!;
    }
    if (result.length !== 32) fail("output_file_unsafe");
    return result;
  } finally {
    REFLECT_APPLY(TYPED_ARRAY_FILL, random, [0]);
  }
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || isProxy(value)
    || REFLECT_APPLY(ARRAY_IS_ARRAY, ARRAY_CONSTRUCTOR, [value])
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [value]) !== OBJECT_PROTOTYPE
  ) {
    return false;
  }
  const keys = REFLECT_APPLY(OBJECT_KEYS, OBJECT_CONSTRUCTOR, [value]) as string[];
  if (
    isProxy(keys)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [keys]) !== ARRAY_PROTOTYPE
    || keys.length !== expected.length
  ) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (keys[index] !== expected[index]) return false;
    const descriptor = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      OBJECT_CONSTRUCTOR,
      [value, expected[index]!],
    ) as PropertyDescriptor | undefined;
    if (!descriptorDataValue(descriptor).found) return false;
  }
  return true;
}

function parseDiscoveryDeploymentId(source: string): string | null {
  if (REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER, [source, "utf8"]) > 16_384) return null;
  try {
    const parsed: unknown = REFLECT_APPLY(JSON_PARSE, JSON_OBJECT, [source]);
    if (!exactKeys(parsed, ["data"])) return null;
    const data = ownData(parsed, "data");
    if (!exactKeys(data, ["serviceInstance"])) return null;
    const instance = ownData(data, "serviceInstance");
    if (!exactKeys(instance, ["latestDeployment"])) return null;
    const latest = ownData(instance, "latestDeployment");
    const id = exactKeys(latest, ["id"]) ? ownData(latest, "id") : undefined;
    if (
      typeof id !== "string"
      || !regexMatches(UUID_PATTERN, id)
    ) return null;
    return id;
  } catch {
    return null;
  }
}

export function railwayApplicationDeploymentAttestationQueriesAreReadOnly(): boolean {
  const joined = `${RAILWAY_APPLICATION_DEPLOYMENT_TOKEN_SCOPE_QUERY}\n${RAILWAY_APPLICATION_DEPLOYMENT_EMPTY_PATCH_QUERY}\n${RAILWAY_APPLICATION_DEPLOYMENT_DISCOVERY_QUERY}\n${RAILWAY_APPLICATION_DEPLOYMENT_SNAPSHOT_QUERY}`;
  return REFLECT_APPLY(STRING_INCLUDES, joined, ["patch(decryptVariables: false)"])
    && REFLECT_APPLY(STRING_INCLUDES, joined, ["projectToken"])
    && !REFLECT_APPLY(STRING_INCLUDES, joined, ["imageDigest"])
    && REFLECT_APPLY(STRING_INCLUDES, joined, ["meta"])
    && !regexMatches(QUERY_DECRYPT_PATTERN, joined)
    && !regexMatches(QUERY_MUTATION_PATTERN, joined)
    && !regexMatches(QUERY_VARIABLES_PATTERN, joined)
    && !regexMatches(QUERY_LOGS_PATTERN, joined);
}

interface ParsedArguments {
  readonly candidateSha: string;
  readonly outputReceipt: string;
  readonly targetOrigin: string;
  readonly targetOriginSha256: string;
}

function exactArgumentAt(argv: readonly string[], index: number): string {
  const key = REFLECT_APPLY(NUMBER_TO_STRING, index, []) as string;
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [argv, key],
  ) as PropertyDescriptor | undefined;
  const data = descriptorDataValue(descriptor);
  if (!data.found || typeof data.value !== "string") return fail("argument_invalid");
  return data.value;
}

function argumentSlot(name: string): 0 | 1 | 2 | 3 | undefined {
  switch (name) {
    case "--candidate-sha": return 0;
    case "--output-receipt": return 1;
    case "--target-origin": return 2;
    case "--target-origin-sha256": return 3;
    default: return undefined;
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (
    isProxy(argv)
    || !REFLECT_APPLY(ARRAY_IS_ARRAY, ARRAY_CONSTRUCTOR, [argv])
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [argv]) !== ARRAY_PROTOTYPE
    || argv.length < ARGUMENT_COUNT
    || argv.length > ARGUMENT_COUNT * 2
  ) return fail("argument_invalid");
  const values: Array<string | undefined> = [undefined, undefined, undefined, undefined];
  for (let index = 0; index < argv.length; index += 1) {
    const raw = exactArgumentAt(argv, index);
    if (!REFLECT_APPLY(STRING_STARTS_WITH, raw, ["--"])) fail("argument_invalid");
    const equals = REFLECT_APPLY(STRING_INDEX_OF, raw, ["="]) as number;
    const name = equals >= 0
      ? REFLECT_APPLY(STRING_SLICE, raw, [0, equals]) as string
      : raw;
    const slot = argumentSlot(name);
    if (slot === undefined || values[slot] !== undefined) fail("argument_invalid");
    let value: string;
    if (equals >= 0) {
      value = REFLECT_APPLY(STRING_SLICE, raw, [equals + 1]) as string;
    } else {
      index += 1;
      if (index >= argv.length) fail("argument_invalid");
      value = exactArgumentAt(argv, index);
    }
    if (value.length === 0 || REFLECT_APPLY(STRING_STARTS_WITH, value, ["--"])) {
      fail("argument_invalid");
    }
    values[slot] = value;
  }
  if (
    values[0] === undefined
    || values[1] === undefined
    || values[2] === undefined
    || values[3] === undefined
  ) return fail("argument_invalid");
  const parsed = REFLECT_APPLY(OBJECT_CREATE, OBJECT_CONSTRUCTOR, [null]) as ParsedArguments;
  (parsed as { candidateSha: string }).candidateSha = values[0];
  (parsed as { outputReceipt: string }).outputReceipt = values[1];
  (parsed as { targetOrigin: string }).targetOrigin = values[2];
  (parsed as { targetOriginSha256: string }).targetOriginSha256 = values[3];
  return REFLECT_APPLY(OBJECT_FREEZE, OBJECT_CONSTRUCTOR, [parsed]) as ParsedArguments;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const parts = exactResponseParts(response);
  if (!parts.body) return opaqueFailure();
  const contentLength = headerValue(parts.headers, "content-length");
  if (
    contentLength !== null
    && (
      !regexMatches(DIGITS_PATTERN, contentLength)
      || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [
        REFLECT_APPLY(NUMBER_CONSTRUCTOR, undefined, [contentLength]),
      ])
      || (REFLECT_APPLY(NUMBER_CONSTRUCTOR, undefined, [contentLength]) as number)
        > maximumBytes
    )
  ) {
    await cancelStream(parts.body);
    return opaqueFailure();
  }
  const reader = REFLECT_APPLY(READABLE_STREAM_GET_READER, parts.body, []) as unknown;
  if (
    typeof reader !== "object"
    || reader === null
    || isProxy(reader)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [reader]) !== READER_PROTOTYPE
  ) {
    await cancelStream(parts.body);
    return opaqueFailure();
  }
  const exactReader = reader as ReadableStreamDefaultReader<Uint8Array>;
  const retained = new UINT8_ARRAY(maximumBytes);
  let exact: Uint8Array | null = null;
  let totalBytes = 0;
  try {
    while (true) {
      const next = await REFLECT_APPLY(READER_READ, exactReader, []);
      if (!exactKeys(next, ["value", "done"])) {
        await cancelReader(exactReader);
        return opaqueFailure();
      }
      const done = ownData(next, "done");
      const chunk = ownData(next, "value");
      if (typeof done !== "boolean") {
        await cancelReader(exactReader);
        return opaqueFailure();
      }
      if (done) {
        if (chunk !== undefined) return opaqueFailure();
        break;
      }
      if (
        typeof chunk !== "object"
        || chunk === null
        || isProxy(chunk)
        || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [chunk])
          !== UINT8_ARRAY_PROTOTYPE
        || typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function"
      ) {
        await cancelReader(exactReader);
        return opaqueFailure();
      }
      const chunkLength = REFLECT_APPLY(
        TYPED_ARRAY_BYTE_LENGTH_GETTER,
        chunk,
        [],
      ) as number;
      if (chunkLength < 1 || totalBytes + chunkLength > maximumBytes) {
        await cancelReader(exactReader);
        return opaqueFailure();
      }
      REFLECT_APPLY(TYPED_ARRAY_SET, retained, [chunk, totalBytes]);
      totalBytes += chunkLength;
    }
    exact = new UINT8_ARRAY(totalBytes);
    for (let index = 0; index < totalBytes; index += 1) {
      exact[index] = retained[index]!;
    }
    const decoder = new TEXT_DECODER("utf-8", TEXT_DECODER_OPTIONS);
    if (isProxy(decoder)) return opaqueFailure();
    const decoded = REFLECT_APPLY(TEXT_DECODER_DECODE, decoder, [exact]) as unknown;
    if (typeof decoded !== "string") return opaqueFailure();
    return decoded;
  } finally {
    try {
      REFLECT_APPLY(READER_RELEASE_LOCK, exactReader, []);
    } catch {
      // The fixed failure path owns reader cleanup.
    }
    REFLECT_APPLY(TYPED_ARRAY_FILL, retained, [0]);
    if (exact) REFLECT_APPLY(TYPED_ARRAY_FILL, exact, [0]);
  }
}

interface ExactResponseParts {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly headers: Headers;
  readonly ok: boolean;
  readonly status: number;
}

function exactResponseParts(response: unknown): ExactResponseParts {
  if (
    typeof response !== "object"
    || response === null
    || isProxy(response)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [response]) !== RESPONSE_PROTOTYPE
    || typeof RESPONSE_BODY_GETTER !== "function"
    || typeof RESPONSE_HEADERS_GETTER !== "function"
    || typeof RESPONSE_OK_GETTER !== "function"
    || typeof RESPONSE_STATUS_GETTER !== "function"
  ) return opaqueFailure();
  const body = REFLECT_APPLY(RESPONSE_BODY_GETTER, response, []) as unknown;
  const headers = REFLECT_APPLY(RESPONSE_HEADERS_GETTER, response, []) as unknown;
  const ok = REFLECT_APPLY(RESPONSE_OK_GETTER, response, []) as unknown;
  const status = REFLECT_APPLY(RESPONSE_STATUS_GETTER, response, []) as unknown;
  if (
    !(body === null || (
      typeof body === "object"
      && !isProxy(body)
      && REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [body])
        === READABLE_STREAM_PROTOTYPE
    ))
    || typeof headers !== "object"
    || headers === null
    || isProxy(headers)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [headers]) !== HEADERS_PROTOTYPE
    || typeof ok !== "boolean"
    || typeof status !== "number"
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [status])
    || status < 100
    || status > 599
  ) return opaqueFailure();
  return { body, headers, ok, status } as ExactResponseParts;
}

function headerValue(headers: Headers, name: string): string | null {
  const value = REFLECT_APPLY(HEADERS_GET, headers, [name]) as unknown;
  if (!(value === null || (typeof value === "string" && value.length <= 4_096))) {
    return opaqueFailure();
  }
  return value;
}

async function cancelStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  try {
    await REFLECT_APPLY(READABLE_STREAM_CANCEL, stream, []);
  } catch {
    // Cancellation is best-effort after a fixed failure decision.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await REFLECT_APPLY(READER_CANCEL, reader, []);
  } catch {
    // Cancellation is best-effort after a fixed failure decision.
  }
}

function abortSignal(timeoutMs: number): AbortSignal {
  if (
    !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [timeoutMs])
    || timeoutMs < 1
    || timeoutMs > REQUEST_TIMEOUT_MS
  ) return opaqueFailure();
  const signal = REFLECT_APPLY(ABORT_SIGNAL_TIMEOUT, ABORT_SIGNAL, [timeoutMs]) as unknown;
  if (
    typeof signal !== "object"
    || signal === null
    || isProxy(signal)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [signal])
      !== ABORT_SIGNAL_PROTOTYPE
  ) return opaqueFailure();
  return signal as AbortSignal;
}

function requestHeaders(values: readonly (readonly [string, string])[]): HeadersInit {
  const headers = REFLECT_APPLY(OBJECT_CREATE, OBJECT_CONSTRUCTOR, [null]) as Record<string, string>;
  for (let index = 0; index < values.length; index += 1) {
    const pair = values[index]!;
    headers[pair[0]] = pair[1];
  }
  return REFLECT_APPLY(OBJECT_FREEZE, OBJECT_CONSTRUCTOR, [headers]) as HeadersInit;
}

function requestInit(input: {
  readonly method: "GET" | "POST";
  readonly headers: HeadersInit;
  readonly signal: AbortSignal;
  readonly body?: string;
  readonly credentials?: "omit";
}): RequestInit {
  const body = ownData(input, "body");
  const credentials = ownData(input, "credentials");
  if (body !== undefined && typeof body !== "string") return opaqueFailure();
  if (credentials !== undefined && credentials !== "omit") return opaqueFailure();
  const init = REFLECT_APPLY(OBJECT_CREATE, OBJECT_CONSTRUCTOR, [null]) as RequestInit;
  init.method = input.method;
  init.headers = input.headers;
  init.cache = "no-store";
  init.redirect = "error";
  init.signal = input.signal;
  if (body !== undefined) init.body = body;
  if (credentials !== undefined) init.credentials = credentials;
  return REFLECT_APPLY(OBJECT_FREEZE, OBJECT_CONSTRUCTOR, [init]) as RequestInit;
}

async function graphqlRequest(
  query: string,
  operationName: string,
  variablesJson: string,
  token: string,
  fetchImpl: typeof fetch,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<string> {
  try {
    assertEnvironmentExact(environment, token);
    const init = requestInit({
      method: "POST",
      headers: requestHeaders([
        ["Accept", "application/json"],
        ["Content-Type", "application/json"],
        ["Project-Access-Token", token],
      ]),
      body: graphqlBody(operationName, query, variablesJson),
      signal: abortSignal(timeoutMs),
    });
    const response = await REFLECT_APPLY(fetchImpl, undefined, [GRAPHQL_ENDPOINT, init]);
    assertEnvironmentExact(environment, token);
    const parts = exactResponseParts(response);
    if (!parts.ok) {
      if (parts.body) await cancelStream(parts.body);
      return fail("metadata_query_failed");
    }
    const contentType = headerValue(parts.headers, "content-type");
    if (contentType === null || !regexMatches(JSON_CONTENT_TYPE_PATTERN, contentType)) {
      if (parts.body) await cancelStream(parts.body);
      return fail("metadata_query_failed");
    }
    return await readBoundedBody(
      response,
      RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_PROVIDER_RESPONSE_BYTES,
    );
  } catch (error) {
    if (safeErrorCode(error) !== undefined) throw error;
    return fail("metadata_query_failed");
  }
}

async function runtimeRequest(
  targetOrigin: string,
  route: "/health" | "/startup" | "/ready",
  fetchImpl: typeof fetch,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<string> {
  try {
    const token = exactEnvironmentValue(environment, STAGING_TOKEN_NAME);
    if (!validToken(token)) return fail("environment_not_allowed");
    assertEnvironmentExact(environment, token);
    const init = requestInit({
      method: "GET",
      headers: requestHeaders([
        ["Accept", "application/json"],
        ["Cache-Control", "no-cache"],
      ]),
      credentials: "omit",
      signal: abortSignal(timeoutMs),
    });
    const response = await REFLECT_APPLY(fetchImpl, undefined, [`${targetOrigin}${route}`, init]);
    assertEnvironmentExact(environment, token);
    const parts = exactResponseParts(response);
    if (parts.status !== 200) {
      if (parts.body) await cancelStream(parts.body);
      return fail("runtime_probe_failed");
    }
    const contentType = headerValue(parts.headers, "content-type");
    const cacheControl = headerValue(parts.headers, "cache-control");
    if (
      contentType === null
      || !regexMatches(JSON_CONTENT_TYPE_PATTERN, contentType)
      || cacheControl === null
      || !regexMatches(CACHE_NO_STORE_PATTERN, cacheControl)
    ) {
      if (parts.body) await cancelStream(parts.body);
      return fail("runtime_probe_failed");
    }
    return await readBoundedBody(
      response,
      RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_RUNTIME_RESPONSE_BYTES,
    );
  } catch (error) {
    if (safeErrorCode(error) !== undefined) throw error;
    return fail("runtime_probe_failed");
  }
}

interface ExactStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly uid: bigint;
}

function exactStat(value: unknown): ExactStat {
  if (
    typeof value !== "object"
    || value === null
    || isProxy(value)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [value])
      !== BIGINT_STATS_PROTOTYPE
  ) return fail("output_file_unsafe");
  const dev = ownData(value, "dev");
  const ino = ownData(value, "ino");
  const mode = ownData(value, "mode");
  const nlink = ownData(value, "nlink");
  const size = ownData(value, "size");
  const uid = ownData(value, "uid");
  if (
    typeof dev !== "bigint"
    || typeof ino !== "bigint"
    || typeof mode !== "bigint"
    || typeof nlink !== "bigint"
    || typeof size !== "bigint"
    || typeof uid !== "bigint"
  ) return fail("output_file_unsafe");
  return { dev, ino, mode, nlink, size, uid };
}

function lstatExact(filename: string): ExactStat {
  return exactStat(REFLECT_APPLY(FS_LSTAT_SYNC, FS_OBJECT, [filename, BIGINT_STAT_OPTIONS]));
}

function fstatExact(fd: number): ExactStat {
  return exactStat(REFLECT_APPLY(FS_FSTAT_SYNC, FS_OBJECT, [fd, BIGINT_STAT_OPTIONS]));
}

function isDirectory(stat: ExactStat): boolean {
  return (stat.mode & S_IFMT) === S_IFDIR;
}

function isRegularFile(stat: ExactStat): boolean {
  return (stat.mode & S_IFMT) === S_IFREG;
}

function realpathExact(filename: string): string {
  const value = REFLECT_APPLY(FS_REALPATH_SYNC, FS_OBJECT, [filename]) as unknown;
  if (typeof value !== "string") return fail("output_file_unsafe");
  return value;
}

function openExact(filename: string, flags: number, mode?: number): number {
  const input = mode === undefined ? [filename, flags] : [filename, flags, mode];
  const fd = REFLECT_APPLY(FS_OPEN_SYNC, FS_OBJECT, input) as unknown;
  if (
    typeof fd !== "number"
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [fd])
    || fd < 0
  ) return fail("output_file_unsafe");
  return fd;
}

function closeExact(fd: number): void {
  REFLECT_APPLY(FS_CLOSE_SYNC, FS_OBJECT, [fd]);
}

function fsyncExact(fd: number): void {
  REFLECT_APPLY(FS_FSYNC_SYNC, FS_OBJECT, [fd]);
}

function currentUid(): bigint {
  if (typeof PROCESS_GETEUID !== "function") return fail("output_file_unsafe");
  const uid = REFLECT_APPLY(PROCESS_GETEUID, PROCESS_OBJECT, []) as unknown;
  if (
    typeof uid !== "number"
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [uid])
    || uid < 0
  ) return fail("output_file_unsafe");
  return REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [uid]) as bigint;
}

function exactBigInt(value: number): bigint {
  return REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [value]) as bigint;
}

function assertFilesystemSupport(): void {
  if (
    !REFLECT_APPLY(NUMBER_IS_INTEGER, NUMBER_CONSTRUCTOR, [O_NOFOLLOW])
    || O_NOFOLLOW <= 0
    || !REFLECT_APPLY(NUMBER_IS_INTEGER, NUMBER_CONSTRUCTOR, [O_DIRECTORY])
    || O_DIRECTORY <= 0
  ) fail("output_file_unsafe");
}

function pathExists(filename: string): boolean {
  try {
    lstatExact(filename);
    return true;
  } catch (error) {
    if (errnoIs(error, "ENOENT")) return false;
    return fail("output_file_unsafe");
  }
}

function exactBufferFromUtf8(value: string): Buffer {
  const bytes = REFLECT_APPLY(BUFFER_FROM, BUFFER, [value, "utf8"]) as unknown;
  if (
    typeof bytes !== "object"
    || bytes === null
    || isProxy(bytes)
    || !REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER, [bytes])
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [bytes]) !== BUFFER_PROTOTYPE
  ) return fail("output_file_unsafe");
  return bytes as Buffer;
}

function exactBufferAlloc(size: number): Buffer {
  const bytes = REFLECT_APPLY(BUFFER_ALLOC, BUFFER, [size]) as unknown;
  if (
    typeof bytes !== "object"
    || bytes === null
    || isProxy(bytes)
    || !REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER, [bytes])
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [bytes]) !== BUFFER_PROTOTYPE
    || typedByteLength(bytes as Uint8Array) !== size
  ) return fail("output_file_unsafe");
  return bytes as Buffer;
}

function typedByteLength(value: Uint8Array): number {
  if (typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function") {
    return fail("unexpected_failure");
  }
  const length = REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []) as unknown;
  if (
    typeof length !== "number"
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [length])
    || length < 0
  ) return fail("unexpected_failure");
  return length;
}

function wipeBytes(value: Uint8Array): void {
  REFLECT_APPLY(TYPED_ARRAY_FILL, value, [0]);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = typedByteLength(left);
  if (length !== typedByteLength(right)) return false;
  let difference = 0;
  for (let index = 0; index < length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function readExactFile(fd: number, size: number): Buffer {
  const bytes = exactBufferAlloc(size);
  let offset = 0;
  while (offset < size) {
    const count = REFLECT_APPLY(FS_READ_SYNC, FS_OBJECT, [
      fd,
      bytes,
      offset,
      size - offset,
      offset,
    ]) as unknown;
    if (
      typeof count !== "number"
      || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [count])
      || count <= 0
      || count > size - offset
    ) return fail("output_file_unsafe");
    offset += count;
  }
  const overflow = exactBufferAlloc(1);
  try {
    const count = REFLECT_APPLY(FS_READ_SYNC, FS_OBJECT, [fd, overflow, 0, 1, size]) as unknown;
    if (count !== 0) return fail("output_file_unsafe");
  } finally {
    wipeBytes(overflow);
  }
  return bytes;
}

function writeExactFile(fd: number, bytes: Buffer): void {
  const size = typedByteLength(bytes);
  let offset = 0;
  while (offset < size) {
    const count = REFLECT_APPLY(FS_WRITE_SYNC, FS_OBJECT, [
      fd,
      bytes,
      offset,
      size - offset,
      offset,
    ]) as unknown;
    if (
      typeof count !== "number"
      || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [count])
      || count <= 0
      || count > size - offset
    ) fail("output_file_unsafe");
    offset += count;
  }
}

function parentExact(
  parent: string,
  parentFd: number,
  identity: { readonly dev: bigint; readonly ino: bigint },
  uid: bigint,
): void {
  const atPath = lstatExact(parent);
  const descriptor = fstatExact(parentFd);
  if (
    realpathExact(parent) !== parent
    || !isDirectory(atPath)
    || atPath.uid !== uid
    || (atPath.mode & 0o7777n) !== 0o700n
    || atPath.dev !== identity.dev
    || atPath.ino !== identity.ino
    || !isDirectory(descriptor)
    || descriptor.uid !== uid
    || (descriptor.mode & 0o7777n) !== 0o700n
    || descriptor.dev !== identity.dev
    || descriptor.ino !== identity.ino
  ) fail("output_file_unsafe");
}

async function preflightOutputPath(filename: string): Promise<void> {
  assertFilesystemSupport();
  const parent = pathDirname(filename);
  const uid = currentUid();
  let parentFd: number | null = null;
  let failed = false;
  try {
    const atPath = lstatExact(parent);
    if (
      realpathExact(parent) !== parent
      || !isDirectory(atPath)
      || atPath.uid !== uid
      || (atPath.mode & 0o7777n) !== 0o700n
    ) fail("output_file_unsafe");
    parentFd = openExact(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    parentExact(parent, parentFd, { dev: atPath.dev, ino: atPath.ino }, uid);
    if (pathExists(filename)) fail("output_file_unsafe");
  } catch (error) {
    failed = true;
    if (safeErrorCode(error) !== undefined) throw error;
    return fail("output_file_unsafe");
  } finally {
    if (parentFd !== null) {
      try { closeExact(parentFd); } catch { if (!failed) fail("output_file_unsafe"); }
    }
  }
}

async function publishReceipt(
  filename: string,
  canonical: string,
  randomBytes: (size: number) => Buffer,
): Promise<PublishedReceipt> {
  assertFilesystemSupport();
  const bytes = exactBufferFromUtf8(canonical);
  const byteLength = typedByteLength(bytes);
  if (
    byteLength < 1
    || byteLength > RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_RECEIPT_BYTES
  ) {
    wipeBytes(bytes);
    return fail("attestation_failed");
  }
  const expectedContentSha256 = sha256(bytes);
  const parent = pathDirname(filename);
  const uid = currentUid();
  let parentFd: number | null = null;
  let fileFd: number | null = null;
  let temporaryPath = "";
  let temporaryOwned = false;
  let published = false;
  let publishedIdentity: { readonly dev: bigint; readonly ino: bigint } | null = null;
  try {
    const parentAtPath = lstatExact(parent);
    if (
      realpathExact(parent) !== parent
      || !isDirectory(parentAtPath)
      || parentAtPath.uid !== uid
      || (parentAtPath.mode & 0o7777n) !== 0o700n
    ) fail("output_file_unsafe");
    parentFd = openExact(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const parentIdentity = { dev: parentAtPath.dev, ino: parentAtPath.ino };
    parentExact(parent, parentFd, parentIdentity, uid);
    if (pathExists(filename)) fail("output_file_unsafe");

    const random = REFLECT_APPLY(randomBytes, undefined, [16]) as Buffer;
    const randomHex = exactRandomHex(random);
    parentExact(parent, parentFd, parentIdentity, uid);
    temporaryPath = pathCall(PATH_JOIN, [
      parent,
      `.pintpath-deployment-attestation-${randomHex}.tmp`,
    ]);
    if (pathDirname(temporaryPath) !== parent) fail("output_file_unsafe");
    fileFd = openExact(
      temporaryPath,
      O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW,
      0o600,
    );
    temporaryOwned = true;
    writeExactFile(fileFd, bytes);
    REFLECT_APPLY(FS_FCHMOD_SYNC, FS_OBJECT, [fileFd, 0o600]);
    fsyncExact(fileFd);
    const written = fstatExact(fileFd);
    if (
      !isRegularFile(written)
      || written.uid !== uid
      || written.nlink !== 1n
      || (written.mode & 0o7777n) !== 0o600n
      || written.size !== exactBigInt(byteLength)
    ) fail("output_file_unsafe");
    let readback: Buffer | null = readExactFile(fileFd, byteLength);
    try {
      if (!bytesEqual(readback, bytes)) fail("output_file_unsafe");
    } finally {
      wipeBytes(readback);
      readback = null;
    }
    REFLECT_APPLY(FS_LINK_SYNC, FS_OBJECT, [temporaryPath, filename]);
    published = true;
    publishedIdentity = { dev: written.dev, ino: written.ino };
    REFLECT_APPLY(FS_UNLINK_SYNC, FS_OBJECT, [temporaryPath]);
    temporaryOwned = false;
    fsyncExact(parentFd);
    const finalStat = lstatExact(filename);
    if (
      !isRegularFile(finalStat)
      || finalStat.uid !== uid
      || finalStat.nlink !== 1n
      || (finalStat.mode & 0o7777n) !== 0o600n
      || finalStat.size !== exactBigInt(byteLength)
      || finalStat.dev !== written.dev
      || finalStat.ino !== written.ino
    ) fail("output_file_unsafe");

    const heldFileFd = fileFd;
    const heldParentFd = parentFd;
    const identity = { dev: written.dev, ino: written.ino };
    let fileOpen = true;
    let parentOpen = true;
    let bytesOwned = true;
    let state: "open" | "verified" | "released" | "failed" | "rolled-back" = "open";
    fileFd = null;
    parentFd = null;

    const wipeOwnedBytes = (): void => {
      if (!bytesOwned) return;
      wipeBytes(bytes);
      bytesOwned = false;
    };

    const assertPublicationExact = (): void => {
      if (!fileOpen || !parentOpen) fail("output_file_unsafe");
      parentExact(parent, heldParentFd, parentIdentity, uid);
      const descriptor = fstatExact(heldFileFd);
      const atPath = lstatExact(filename);
      let readback: Buffer | null = readExactFile(heldFileFd, byteLength);
      try {
        if (
          !isRegularFile(descriptor)
          || descriptor.uid !== uid
          || descriptor.nlink !== 1n
          || (descriptor.mode & 0o7777n) !== 0o600n
          || descriptor.size !== exactBigInt(byteLength)
          || descriptor.dev !== identity.dev
          || descriptor.ino !== identity.ino
          || !isRegularFile(atPath)
          || atPath.uid !== uid
          || atPath.nlink !== 1n
          || (atPath.mode & 0o7777n) !== 0o600n
          || atPath.size !== exactBigInt(byteLength)
          || atPath.dev !== identity.dev
          || atPath.ino !== identity.ino
          || sha256(readback) !== expectedContentSha256
          || !bytesEqual(readback, bytes)
        ) fail("output_file_unsafe");
      } finally {
        wipeBytes(readback);
        readback = null;
      }
    };

    const rollbackExact = async (): Promise<void> => {
      if (state === "rolled-back") return;
      let invalidated = false;
      let failed = false;
      try {
        if (fileOpen) {
          REFLECT_APPLY(FS_FTRUNCATE_SYNC, FS_OBJECT, [heldFileFd, 0]);
          fsyncExact(heldFileFd);
          invalidated = true;
        }
      } catch {
        failed = true;
      }
      if (!invalidated) {
        let fallbackFd: number | null = null;
        try {
          const atPath = lstatExact(filename);
          if (atPath.dev !== identity.dev || atPath.ino !== identity.ino) {
            fail("output_file_unsafe");
          }
          fallbackFd = openExact(filename, O_RDWR | O_NOFOLLOW);
          const descriptor = fstatExact(fallbackFd);
          if (descriptor.dev !== identity.dev || descriptor.ino !== identity.ino) {
            fail("output_file_unsafe");
          }
          REFLECT_APPLY(FS_FTRUNCATE_SYNC, FS_OBJECT, [fallbackFd, 0]);
          fsyncExact(fallbackFd);
          invalidated = true;
        } catch {
          failed = true;
        } finally {
          if (fallbackFd !== null) {
            try { closeExact(fallbackFd); } catch { failed = true; }
          }
        }
      }
      try {
        const atPath = lstatExact(filename);
        if (atPath.dev !== identity.dev || atPath.ino !== identity.ino) {
          failed = true;
        } else {
          REFLECT_APPLY(FS_UNLINK_SYNC, FS_OBJECT, [filename]);
          if (parentOpen) fsyncExact(heldParentFd);
          else failed = true;
        }
      } catch (error) {
        if (!errnoIs(error, "ENOENT")) failed = true;
      }
      if (fileOpen) {
        try { closeExact(heldFileFd); } catch { failed = true; }
        fileOpen = false;
      }
      if (parentOpen) {
        try { closeExact(heldParentFd); } catch { failed = true; }
        parentOpen = false;
      }
      wipeOwnedBytes();
      state = "rolled-back";
      if (!invalidated || failed) fail("output_file_unsafe");
    };

    return OBJECT_FREEZE({
      sha256: expectedContentSha256,
      reassert: async () => {
        if (state !== "open") fail("output_file_unsafe");
        try {
          assertPublicationExact();
        } catch {
          state = "failed";
          return fail("output_file_unsafe");
        }
        state = "verified";
      },
      release: async () => {
        if (state !== "verified") fail("output_file_unsafe");
        try {
          assertPublicationExact();
        } catch {
          state = "failed";
          return fail("output_file_unsafe");
        }
        let failed = false;
        try { closeExact(heldParentFd); parentOpen = false; } catch { failed = true; }
        if (!failed) {
          try { closeExact(heldFileFd); fileOpen = false; } catch { failed = true; }
        }
        state = failed ? "failed" : "released";
        if (failed) fail("output_file_unsafe");
        wipeOwnedBytes();
      },
      rollback: rollbackExact,
    }) as PublishedReceipt;
  } catch (error) {
    let cleanupFailed = false;
    let invalidated = false;
    if (published && fileFd !== null && publishedIdentity) {
      try {
        const descriptor = fstatExact(fileFd);
        if (
          descriptor.dev !== publishedIdentity.dev
          || descriptor.ino !== publishedIdentity.ino
        ) fail("output_file_unsafe");
        REFLECT_APPLY(FS_FTRUNCATE_SYNC, FS_OBJECT, [fileFd, 0]);
        fsyncExact(fileFd);
        invalidated = true;
      } catch {
        cleanupFailed = true;
      }
      try {
        const atPath = lstatExact(filename);
        if (
          atPath.dev !== publishedIdentity.dev
          || atPath.ino !== publishedIdentity.ino
        ) cleanupFailed = true;
        else {
          REFLECT_APPLY(FS_UNLINK_SYNC, FS_OBJECT, [filename]);
          if (parentFd !== null) fsyncExact(parentFd);
        }
      } catch (cleanupError) {
        if (!errnoIs(cleanupError, "ENOENT")) cleanupFailed = true;
      }
      if (!invalidated) cleanupFailed = true;
    }
    if (temporaryOwned) {
      try { REFLECT_APPLY(FS_UNLINK_SYNC, FS_OBJECT, [temporaryPath]); } catch { cleanupFailed = true; }
    }
    if (fileFd !== null) {
      try { closeExact(fileFd); } catch { cleanupFailed = true; }
    }
    if (parentFd !== null) {
      try { closeExact(parentFd); } catch { cleanupFailed = true; }
    }
    wipeBytes(bytes);
    if (cleanupFailed) return fail("output_file_unsafe");
    if (safeErrorCode(error) !== undefined) throw error;
    return fail("output_file_unsafe");
  }
}

function successSummary(candidateSha: string, receiptFileSha256: string): string {
  return `{"activationAuthorized":false,"candidateSha":${jsonString(candidateSha)},"command":"attest","expectedEnvironment":"permanent-staging","launchBlockerRemoved":false,"mutationEnabled":false,"ok":true,"receiptFileSha256":${jsonString(receiptFileSha256)}}\n`;
}

function failureSummary(failureCode: FailureCode): string {
  return `{"command":"attest","failureCode":${jsonString(failureCode)},"ok":false}\n`;
}

async function runWithDependencies(
  argv: readonly string[],
  dependencies: RuntimeDependencies,
  readLockedEnvironment?: () => Readonly<Record<string, string | undefined>>,
): Promise<0 | 1> {
  let published: PublishedReceipt | null = null;
  let fixedWriteOutput: ((value: string) => void) | null = null;
  try {
    const productionGuard = dependencies.assertProductionBoundary;
    if (productionGuard !== undefined) {
      if (typeof productionGuard !== "function") fail("unexpected_failure");
      REFLECT_APPLY(productionGuard, undefined, []);
    }
    const fetchImpl = dependencies.fetchImpl;
    const now = dependencies.now;
    const randomBytes = dependencies.randomBytes;
    const writeOutput = dependencies.writeOutput;
    if (
      typeof fetchImpl !== "function"
      || typeof now !== "function"
      || typeof randomBytes !== "function"
      || typeof writeOutput !== "function"
    ) fail("unexpected_failure");
    fixedWriteOutput = writeOutput;
    const args = parseArguments(argv);
    const candidateSha = exactCandidateSha(args.candidateSha);
    const outputReceipt = exactAbsolutePath(args.outputReceipt);
    const targetOrigin = exactTargetOrigin(args.targetOrigin);
    if (sha256(targetOrigin) !== exactSha256(args.targetOriginSha256)) {
      fail("argument_invalid");
    }
    if (!railwayApplicationDeploymentAttestationQueriesAreReadOnly()) {
      fail("policy_invalid");
    }
    await preflightOutputPath(outputReceipt);
    const policySource = REFLECT_APPLY(
      FS_READ_FILE_SYNC,
      FS_OBJECT,
      [POLICY_PATH, "utf8"],
    ) as unknown;
    if (typeof policySource !== "string") fail("policy_invalid");
    const policy = parseRailwayApplicationDeploymentAttestationPolicy(policySource);
    if (!policy) fail("policy_invalid");
    const environment = readLockedEnvironment === undefined
      ? dependencies.environment
      : REFLECT_APPLY(readLockedEnvironment, undefined, []);
    assertNoForbiddenAmbientAuthority(environment);
    const token = exactEnvironmentValue(environment, STAGING_TOKEN_NAME);
    if (!validToken(token)) fail("token_invalid");
    const startedAt = exactDate(REFLECT_APPLY(now, undefined, []));
    const startedMs = REFLECT_APPLY(DATE_GET_TIME, startedAt, []) as number;
    const requestTimeout = (): number => {
      const current = exactDate(REFLECT_APPLY(now, undefined, []));
      const currentMs = REFLECT_APPLY(DATE_GET_TIME, current, []) as number;
      const remaining = startedMs
        + policy.limits.maximumObservationSeconds * 1_000
        - currentMs;
      if (currentMs < startedMs || remaining <= 0) fail("attestation_failed");
      return remaining < REQUEST_TIMEOUT_MS ? remaining : REQUEST_TIMEOUT_MS;
    };

    const tokenScopeSource = await graphqlRequest(
      RAILWAY_APPLICATION_DEPLOYMENT_TOKEN_SCOPE_QUERY,
      "PintPathRailwayApplicationDeploymentTokenScope",
      "{}",
      token,
      fetchImpl,
      environment,
      requestTimeout(),
    );
    const tokenScope = parseRailwayApplicationDeploymentAttestationTokenScopeResponse(
      tokenScopeSource,
    );
    if (!tokenScope) fail("metadata_query_failed");

    const queryPatch = async () => {
      const source = await graphqlRequest(
        RAILWAY_APPLICATION_DEPLOYMENT_EMPTY_PATCH_QUERY,
        "PintPathRailwayApplicationDeploymentEmptyPatch",
        twoVariablesJson(
          "projectId",
          policy.projectId,
          "environmentId",
          policy.stagingEnvironmentId,
        ),
        token,
        fetchImpl,
        environment,
        requestTimeout(),
      );
      const parsed = parseRailwayApplicationDeploymentAttestationEmptyPatchResponse(source);
      if (!parsed) fail("metadata_query_failed");
      return parsed;
    };
    const querySnapshot = async () => {
      const discovery = await graphqlRequest(
        RAILWAY_APPLICATION_DEPLOYMENT_DISCOVERY_QUERY,
        "PintPathRailwayApplicationDeploymentDiscovery",
        twoVariablesJson(
          "environmentId",
          policy.stagingEnvironmentId,
          "serviceId",
          policy.serviceId,
        ),
        token,
        fetchImpl,
        environment,
        requestTimeout(),
      );
      const deploymentId = parseDiscoveryDeploymentId(discovery);
      if (!deploymentId) fail("metadata_query_failed");
      const source = await graphqlRequest(
        RAILWAY_APPLICATION_DEPLOYMENT_SNAPSHOT_QUERY,
        "PintPathRailwayApplicationDeploymentSnapshot",
        threeVariablesJson(
          policy.stagingEnvironmentId,
          policy.serviceId,
          deploymentId,
        ),
        token,
        fetchImpl,
        environment,
        requestTimeout(),
      );
      const parsed = parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse(
        source,
      );
      if (!parsed) fail("metadata_query_failed");
      return parsed;
    };

    const patchBefore = await queryPatch();
    const providerBefore = await querySnapshot();
    const healthSource = await runtimeRequest(
      targetOrigin,
      "/health",
      fetchImpl,
      environment,
      requestTimeout(),
    );
    const startupSource = await runtimeRequest(
      targetOrigin,
      "/startup",
      fetchImpl,
      environment,
      requestTimeout(),
    );
    const readySource = await runtimeRequest(
      targetOrigin,
      "/ready",
      fetchImpl,
      environment,
      requestTimeout(),
    );
    const health = parseRailwayApplicationDeploymentAttestationRuntimeResponse(
      "/health",
      healthSource,
    );
    const startup = parseRailwayApplicationDeploymentAttestationRuntimeResponse(
      "/startup",
      startupSource,
    );
    const ready = parseRailwayApplicationDeploymentAttestationRuntimeResponse(
      "/ready",
      readySource,
    );
    if (!health || !startup || !ready) fail("runtime_probe_failed");
    const providerAfter = await querySnapshot();
    const patchAfter = await queryPatch();
    const completedAt = exactDate(REFLECT_APPLY(now, undefined, []));
    const evaluation = evaluateRailwayApplicationDeploymentAttestation({
      policy,
      policySha256: sha256(policySource),
      candidateSha,
      targetOrigin,
      targetOriginSha256: sha256(targetOrigin),
      startedAt: exactDateIso(startedAt),
      completedAt: exactDateIso(completedAt),
      queriesReadOnly: true,
      tokenScope,
      patchBefore,
      providerBefore,
      runtime: { health, startup, ready },
      patchAfter,
      providerAfter,
    });
    if (!evaluation) fail("attestation_failed");
    const receipt = buildRailwayApplicationDeploymentAttestationReceipt(evaluation);
    const canonical = canonicalRailwayApplicationDeploymentAttestationReceipt(receipt);
    published = await publishReceipt(outputReceipt, canonical, randomBytes);
    await published.reassert();
    REFLECT_APPLY(writeOutput, undefined, [successSummary(candidateSha, published.sha256)]);
    await published.release();
    published = null;
    return 0;
  } catch (error) {
    let cleanupFailed = false;
    if (published) {
      try { await published.rollback(); } catch { cleanupFailed = true; }
    }
    const fixedCode = safeErrorCode(error);
    const failureCode: FailureCode = cleanupFailed
      ? "output_file_unsafe"
      : fixedCode ?? "unexpected_failure";
    try {
      if (fixedWriteOutput) {
        REFLECT_APPLY(fixedWriteOutput, undefined, [failureSummary(failureCode)]);
      }
    } catch {
      // The output capability failed; do not expose the original error.
    }
    return 1;
  }
}

export async function runRailwayApplicationDeploymentAttestation(
  argv: readonly string[],
): Promise<0 | 1> {
  return runWithDependencies(
    argv,
    RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RUNTIME,
  );
}

export async function runLockedRailwayApplicationDeploymentAttestation(
  argv: readonly string[],
  readToken: () => string,
): Promise<0 | 1> {
  assertLockedSensitiveWorkerBoundary("attestor");
  if (typeof readToken !== "function") fail("unexpected_failure");
  let invoked = false;
  const readEnvironment = (): Readonly<Record<string, string | undefined>> => {
    assertLockedSensitiveWorkerBoundary("attestor");
    if (invoked) fail("unexpected_failure");
    invoked = true;
    const token = REFLECT_APPLY(readToken, undefined, []) as unknown;
    if (typeof token !== "string" || !validToken(token)) fail("token_invalid");
    assertLockedSensitiveWorkerBoundary("attestor");
    return REFLECT_APPLY(OBJECT_FREEZE, OBJECT_CONSTRUCTOR, [{
      [STAGING_TOKEN_NAME]: token,
    }]) as Readonly<Record<string, string | undefined>>;
  };
  const result = await runWithDependencies(
    argv,
    RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RUNTIME,
    readEnvironment,
  );
  assertLockedSensitiveWorkerBoundary("attestor");
  return result;
}

export const railwayApplicationDeploymentAttestationCliInternals = OBJECT_FREEZE({
  ARGUMENT_COUNT,
  POLICY_PATH,
  parseDiscoveryDeploymentId,
  readBoundedBody,
});

const invokedPath = process.argv[1] ? pathResolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRailwayApplicationDeploymentAttestation(
    REFLECT_APPLY(ARRAY_SLICE, process.argv, [2]) as string[],
  );
}
