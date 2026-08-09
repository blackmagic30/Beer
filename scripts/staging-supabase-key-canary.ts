import path from "node:path";
import { fileURLToPath } from "node:url";

export const STAGING_SUPABASE_KEY_CANARY_LOCK = Object.freeze({
  projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  serviceId: "e8095943-0d46-4a57-9db4-afe952a42386",
  railwayConfigPath: "/railway.supabase-key-canary.toml",
  stagingOrigin: "https://bbfibbadwjxzrcdncavy.supabase.co",
  offsiteOrigin: "https://hfbmhdxrwtihukmixxta.supabase.co",
  stagingBucketId: "beermap-source-evidence",
  offsiteBucketId: "pintpath-backups",
} as const);

export const STAGING_SUPABASE_KEY_CANARY_SCHEMA =
  "pintpath-staging-supabase-key-canary/v1" as const;
export const STAGING_SUPABASE_KEY_CANARY_SCOPE =
  "permanent-staging-replacement-keys" as const;
export const STAGING_SUPABASE_KEY_CANARY_REQUEST_TIMEOUT_MS = 10_000;
export const STAGING_SUPABASE_KEY_CANARY_MAX_RESPONSE_BYTES = 64 * 1_024;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9_-]{20,220}$/;
const SECRET_KEY_PATTERN = /^sb_secret_[A-Za-z0-9_-]{20,220}$/;
const DEBUG_OR_TRANSPORT_ENVIRONMENT = [
  "ALL_PROXY",
  "DEBUG",
  "DEBUG_FD",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "all_proxy",
  "https_proxy",
  "http_proxy",
] as const;
const STAGING_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
const OFFSITE_ALLOWED_MIME_TYPES = [
  "application/json",
  "application/octet-stream",
  "application/pdf",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

interface CanaryIdentity {
  railwayProject: boolean;
  railwayEnvironment: boolean;
  railwayService: boolean;
  railwayDeployment: boolean;
  dedicatedRailwayConfig: boolean;
  debugAndProxyLoggingDisabled: boolean;
  stagingOrigin: boolean;
  offsiteOrigin: boolean;
  originsDistinct: boolean;
  bucketIdsExact: boolean;
  replacementKeyShapes: boolean;
  replacementKeysDistinct: boolean;
}

interface CanaryChecks {
  stagingAuthSettings: boolean;
  stagingAuthAdmin: boolean;
  stagingPrivateStorage: boolean;
  offsitePrivateStorage: boolean;
}

export interface StagingSupabaseKeyCanaryReceipt {
  schemaVersion: typeof STAGING_SUPABASE_KEY_CANARY_SCHEMA;
  scope: typeof STAGING_SUPABASE_KEY_CANARY_SCOPE;
  outcome: "passed" | "failed";
  deploymentId: string | null;
  identity: CanaryIdentity;
  checks: CanaryChecks;
}

interface StagingSupabaseKeyCanaryDependencies {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  fetchImpl: typeof globalThis.fetch;
  requestTimeoutMs: number;
  writeOutput: (output: string) => void;
}

interface ValidConfiguration {
  stagingPublishableKey: string;
  stagingSecretKey: string;
  offsiteSecretKey: string;
}

const DEFAULT_DEPENDENCIES: StagingSupabaseKeyCanaryDependencies = {
  argv: process.argv.slice(2),
  env: process.env,
  fetchImpl: globalThis.fetch,
  requestTimeoutMs: STAGING_SUPABASE_KEY_CANARY_REQUEST_TIMEOUT_MS,
  writeOutput: (output) => process.stdout.write(output),
};

function emptyIdentity(): CanaryIdentity {
  return {
    railwayProject: false,
    railwayEnvironment: false,
    railwayService: false,
    railwayDeployment: false,
    dedicatedRailwayConfig: false,
    debugAndProxyLoggingDisabled: false,
    stagingOrigin: false,
    offsiteOrigin: false,
    originsDistinct: false,
    bucketIdsExact: false,
    replacementKeyShapes: false,
    replacementKeysDistinct: false,
  };
}

function emptyChecks(): CanaryChecks {
  return {
    stagingAuthSettings: false,
    stagingAuthAdmin: false,
    stagingPrivateStorage: false,
    offsitePrivateStorage: false,
  };
}

function fixedReceipt(
  deploymentId: string | null = null,
  identity: CanaryIdentity = emptyIdentity(),
  checks: CanaryChecks = emptyChecks(),
): StagingSupabaseKeyCanaryReceipt {
  const passed = [...Object.values(identity), ...Object.values(checks)].every(
    (value) => value === true,
  );
  return {
    schemaVersion: STAGING_SUPABASE_KEY_CANARY_SCHEMA,
    scope: STAGING_SUPABASE_KEY_CANARY_SCOPE,
    outcome: passed ? "passed" : "failed",
    deploymentId,
    identity,
    checks,
  };
}

function writeReceipt(
  writeOutput: (output: string) => void,
  receipt: StagingSupabaseKeyCanaryReceipt,
): void {
  writeOutput(`${JSON.stringify(receipt)}\n`);
}

function exactEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  maximumLength: number,
): string {
  const value = env[name];
  return typeof value === "string" &&
      value.length >= 1 &&
      value.length <= maximumLength &&
      value === value.trim() &&
      !/[\u0000\r\n]/.test(value)
    ? value
    : "";
}

function environmentDisabled(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  return env[name] === undefined || env[name] === "";
}

function configurationFromEnvironment(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): {
  deploymentId: string | null;
  identity: CanaryIdentity;
  configuration: ValidConfiguration | null;
} {
  const identity = emptyIdentity();
  identity.railwayProject =
    exactEnvironment(env, "RAILWAY_PROJECT_ID", 128) ===
    STAGING_SUPABASE_KEY_CANARY_LOCK.projectId;
  identity.railwayEnvironment =
    exactEnvironment(env, "RAILWAY_ENVIRONMENT_ID", 128) ===
    STAGING_SUPABASE_KEY_CANARY_LOCK.environmentId;
  identity.railwayService =
    exactEnvironment(env, "RAILWAY_SERVICE_ID", 128) ===
    STAGING_SUPABASE_KEY_CANARY_LOCK.serviceId;
  const railwayDeploymentId = exactEnvironment(
    env,
    "RAILWAY_DEPLOYMENT_ID",
    128,
  );
  identity.railwayDeployment = UUID_PATTERN.test(railwayDeploymentId);
  identity.dedicatedRailwayConfig =
    argv.length === 0 &&
    exactEnvironment(
      env,
      "STAGING_SUPABASE_KEY_CANARY_RAILWAY_CONFIG_PATH",
      128,
    ) === STAGING_SUPABASE_KEY_CANARY_LOCK.railwayConfigPath;
  identity.debugAndProxyLoggingDisabled = DEBUG_OR_TRANSPORT_ENVIRONMENT.every(
    (name) => environmentDisabled(env, name),
  );

  const stagingOrigin = exactEnvironment(env, "SUPABASE_URL", 256);
  const offsiteOrigin = exactEnvironment(
    env,
    "OFFSITE_BACKUP_SUPABASE_URL",
    256,
  );
  const offsiteBucketId = exactEnvironment(
    env,
    "OFFSITE_BACKUP_BUCKET",
    128,
  );
  identity.stagingOrigin =
    stagingOrigin === STAGING_SUPABASE_KEY_CANARY_LOCK.stagingOrigin;
  identity.offsiteOrigin =
    offsiteOrigin === STAGING_SUPABASE_KEY_CANARY_LOCK.offsiteOrigin;
  identity.originsDistinct =
    identity.stagingOrigin && identity.offsiteOrigin && stagingOrigin !== offsiteOrigin;
  identity.bucketIdsExact =
    STAGING_SUPABASE_KEY_CANARY_LOCK.stagingBucketId ===
      "beermap-source-evidence" &&
    offsiteBucketId === STAGING_SUPABASE_KEY_CANARY_LOCK.offsiteBucketId;

  const stagingPublishableKey = exactEnvironment(
    env,
    "SUPABASE_ANON_KEY",
    256,
  );
  const stagingSecretKey = exactEnvironment(
    env,
    "SUPABASE_SERVICE_ROLE_KEY",
    256,
  );
  const offsiteSecretKey = exactEnvironment(
    env,
    "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
    256,
  );
  identity.replacementKeyShapes =
    PUBLISHABLE_KEY_PATTERN.test(stagingPublishableKey) &&
    SECRET_KEY_PATTERN.test(stagingSecretKey) &&
    SECRET_KEY_PATTERN.test(offsiteSecretKey);
  identity.replacementKeysDistinct =
    identity.replacementKeyShapes &&
    stagingPublishableKey !== stagingSecretKey &&
    stagingPublishableKey !== offsiteSecretKey &&
    stagingSecretKey !== offsiteSecretKey;

  const valid = Object.values(identity).every((value) => value === true);
  return {
    deploymentId: identity.railwayDeployment ? railwayDeploymentId : null,
    identity,
    configuration: valid
      ? { stagingPublishableKey, stagingSecretKey, offsiteSecretKey }
      : null,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

async function readBoundedJson(response: Response): Promise<unknown | null> {
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) return null;
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d{1,10}$/.test(contentLength) ||
      Number(contentLength) > STAGING_SUPABASE_KEY_CANARY_MAX_RESPONSE_BYTES)
  ) {
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > STAGING_SUPABASE_KEY_CANARY_MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
    if (bytes < 2) return null;
    const merged = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(merged);
    return JSON.parse(source) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function fetchJson(input: {
  fetchImpl: typeof globalThis.fetch;
  url: string;
  apiKey: string;
  timeoutMs: number;
}): Promise<unknown | null> {
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > STAGING_SUPABASE_KEY_CANARY_REQUEST_TIMEOUT_MS
  ) {
    return null;
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, input.timeoutMs);
    });
    const requestAndBody = (async (): Promise<unknown | null> => {
      const response = await input.fetchImpl(input.url, {
        method: "GET",
        headers: { apikey: input.apiKey },
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
      return await readBoundedJson(response);
    })();
    return await Promise.race([requestAndBody, timeout]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

function isAuthSettings(value: unknown): boolean {
  if (!isPlainRecord(value) || !isPlainRecord(value.external)) return false;
  const externalEntries = Object.entries(value.external);
  return (
    typeof value.disable_signup === "boolean" &&
    externalEntries.length >= 1 &&
    externalEntries.length <= 64 &&
    externalEntries.every(
      ([name, enabled]) =>
        /^[a-z][a-z0-9_]{0,63}$/.test(name) && typeof enabled === "boolean",
    )
  );
}

function isAuthAdminUserPage(value: unknown): boolean {
  return isPlainRecord(value)
    && Array.isArray(value.users)
    && value.users.length <= 1
    && value.users.every((user) => isPlainRecord(user));
}

function exactMimeTypes(
  value: unknown,
  expected: readonly string[],
): boolean {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    !value.every(
      (candidate) =>
        typeof candidate === "string" &&
        candidate.length >= 1 &&
        candidate.length <= 128,
    )
  ) {
    return false;
  }
  const actual = [...value].sort();
  return new Set(actual).size === expected.length &&
    actual.every((candidate, index) => candidate === expected[index]);
}

function isStorageBucket(
  value: unknown,
  expected: {
    id: string;
    fileSizeLimit: number | null;
    allowedMimeTypes: readonly string[];
  },
): boolean {
  return (
    isPlainRecord(value) &&
    value.id === expected.id &&
    value.name === expected.id &&
    value.public === false &&
    value.file_size_limit === expected.fileSizeLimit &&
    exactMimeTypes(value.allowed_mime_types, expected.allowedMimeTypes)
  );
}

async function runReadOnlyCanaries(
  configuration: ValidConfiguration,
  dependencies: StagingSupabaseKeyCanaryDependencies,
): Promise<CanaryChecks> {
  const [authSettings, authAdmin, stagingBucket, offsiteBucket] = await Promise.all([
    fetchJson({
      fetchImpl: dependencies.fetchImpl,
      url: `${STAGING_SUPABASE_KEY_CANARY_LOCK.stagingOrigin}/auth/v1/settings`,
      apiKey: configuration.stagingPublishableKey,
      timeoutMs: dependencies.requestTimeoutMs,
    }),
    fetchJson({
      fetchImpl: dependencies.fetchImpl,
      url: `${STAGING_SUPABASE_KEY_CANARY_LOCK.stagingOrigin}/auth/v1/admin/users?page=1&per_page=1`,
      apiKey: configuration.stagingSecretKey,
      timeoutMs: dependencies.requestTimeoutMs,
    }),
    fetchJson({
      fetchImpl: dependencies.fetchImpl,
      url: `${STAGING_SUPABASE_KEY_CANARY_LOCK.stagingOrigin}/storage/v1/bucket/${STAGING_SUPABASE_KEY_CANARY_LOCK.stagingBucketId}`,
      apiKey: configuration.stagingSecretKey,
      timeoutMs: dependencies.requestTimeoutMs,
    }),
    fetchJson({
      fetchImpl: dependencies.fetchImpl,
      url: `${STAGING_SUPABASE_KEY_CANARY_LOCK.offsiteOrigin}/storage/v1/bucket/${STAGING_SUPABASE_KEY_CANARY_LOCK.offsiteBucketId}`,
      apiKey: configuration.offsiteSecretKey,
      timeoutMs: dependencies.requestTimeoutMs,
    }),
  ]);
  return {
    stagingAuthSettings: isAuthSettings(authSettings),
    stagingAuthAdmin: isAuthAdminUserPage(authAdmin),
    stagingPrivateStorage: isStorageBucket(stagingBucket, {
      id: STAGING_SUPABASE_KEY_CANARY_LOCK.stagingBucketId,
      fileSizeLimit: 8 * 1_024 * 1_024,
      allowedMimeTypes: STAGING_ALLOWED_MIME_TYPES,
    }),
    offsitePrivateStorage: isStorageBucket(offsiteBucket, {
      id: STAGING_SUPABASE_KEY_CANARY_LOCK.offsiteBucketId,
      fileSizeLimit: null,
      allowedMimeTypes: OFFSITE_ALLOWED_MIME_TYPES,
    }),
  };
}

export async function runStagingSupabaseKeyCanary(
  overrides: Partial<StagingSupabaseKeyCanaryDependencies> = {},
): Promise<0 | 1> {
  const dependencies: StagingSupabaseKeyCanaryDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  let identity = emptyIdentity();
  let checks = emptyChecks();
  let deploymentId: string | null = null;
  try {
    const configured = configurationFromEnvironment(
      dependencies.argv,
      dependencies.env,
    );
    identity = configured.identity;
    deploymentId = configured.deploymentId;
    if (configured.configuration) {
      checks = await runReadOnlyCanaries(configured.configuration, dependencies);
    }
  } catch {
    checks = emptyChecks();
  }
  const receipt = fixedReceipt(deploymentId, identity, checks);
  writeReceipt(dependencies.writeOutput, receipt);
  return receipt.outcome === "passed" ? 0 : 1;
}

export const stagingSupabaseKeyCanaryInternals = {
  configurationFromEnvironment,
  exactMimeTypes,
  fetchJson,
  isAuthAdminUserPage,
  isAuthSettings,
  isStorageBucket,
  readBoundedJson,
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runStagingSupabaseKeyCanary();
}
