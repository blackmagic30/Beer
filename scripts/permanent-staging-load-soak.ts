import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { railwayDeploymentIdentityIdSha256 } from "../src/lib/railway-deployment-identity.js";
import { isRestoreRehearsalEnvironment } from "./lib/operator-mutation-guard.js";

export type PermanentStagingLoadProfile = "expected-peak" | "2x-peak" | "soak";
export type LoadTrafficClass = "public" | "admin" | "authenticated_write" | "authenticated_read";

export type LoadSoakConfigurationFailureCode =
  | "arguments_invalid"
  | "mutation_confirmation_missing"
  | "disposable_user_confirmation_missing"
  | "restore_mode_detected"
  | "target_invalid"
  | "target_not_staging"
  | "target_pin_invalid"
  | "target_pin_mismatch"
  | "target_is_forbidden"
  | "commit_pin_invalid"
  | "identity_pin_invalid"
  | "profile_bounds_invalid"
  | "credential_file_invalid"
  | "fixture_pin_invalid";

export type LoadSoakRunFailureCode =
  | "target_preflight_failed"
  | "target_identity_changed"
  | "credential_scope_invalid"
  | "write_journey_failed"
  | "profile_incomplete"
  | "http_5xx_threshold_failed"
  | "public_p95_threshold_failed"
  | "admin_p95_threshold_failed"
  | "unexpected_http_failure"
  | "network_failure"
  | "timeout_failure"
  | "response_contract_failure"
  | "duplicate_write_failure"
  | "lost_write_failure"
  | "isolation_failure"
  | "replica_participation_failed"
  | "internal_failure";

export interface PermanentStagingLoadConfiguration {
  readonly profile: PermanentStagingLoadProfile;
  readonly durationMs: number;
  readonly ratePerSecond: number;
  readonly maxConcurrency: number;
  readonly requestTimeoutMs: number;
  readonly writeIntervalMs: number;
  readonly writeConcurrency: number;
  readonly expectedReplicaCount: number;
  readonly targetOrigin: string;
  readonly targetOriginSha256: string;
  readonly targetIdentitySha256: string;
  readonly targetProjectIdSha256: string;
  readonly targetEnvironmentIdSha256: string;
  readonly targetServiceIdSha256: string;
  readonly expectedCommitSha: string;
  readonly userATokenFile: string;
  readonly userBTokenFile: string;
  readonly adminTokenFile: string;
  readonly writeFixtureFile: string;
  readonly writeFixtureSha256: string;
}

export interface ReviewedLoadWriteFixture {
  readonly schemaVersion: 1;
  readonly purpose: "permanent-staging-disposable-load";
  readonly reviewed: true;
  readonly venueId: string;
  readonly venueName: string;
  readonly suburb: string | null;
  readonly beerName: "Guinness" | "Carlton Draught" | "Stone & Wood Pacific Ale";
  readonly servingSize: "pint" | "pot" | "schooner" | "jug" | "bottle" | "can" | "other";
  readonly price: number;
  readonly isOnTap: "yes" | "no" | "unknown";
}

export interface PermanentStagingLoadSecrets {
  readonly userAToken: string;
  readonly userBToken: string;
  readonly adminToken: string;
  readonly writeFixture: ReviewedLoadWriteFixture;
}

export interface LoadRouteReport {
  readonly route: string;
  readonly trafficClass: LoadTrafficClass;
  readonly requests: number;
  readonly http2xx: number;
  readonly http4xx: number;
  readonly http5xx: number;
  readonly otherHttp: number;
  readonly networkErrors: number;
  readonly timeouts: number;
  readonly contractFailures: number;
  readonly latencyMs: {
    readonly samples: number;
    readonly min: number | null;
    readonly mean: number | null;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
    readonly max: number | null;
  };
}

export interface PermanentStagingLoadReport {
  readonly schemaVersion: 1;
  readonly kind: "pintpath_permanent_staging_load_soak";
  readonly passed: boolean;
  readonly profile: PermanentStagingLoadProfile;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly configuredDurationSeconds: number;
  readonly configuredRatePerSecond: number;
  readonly configuredMaxConcurrency: number;
  readonly requestTimeoutMs: number;
  readonly targetOriginSha256: string;
  readonly targetIdentitySha256: string;
  readonly writeFixtureSha256: string;
  readonly expectedCommitSha: string;
  readonly thresholds: {
    readonly http5xxRatio: number;
    readonly http5xxLimitExclusive: 0.01;
    readonly publicP95Ms: number | null;
    readonly publicP95LimitExclusiveMs: 2_000;
    readonly adminP95Ms: number | null;
    readonly adminP95LimitExclusiveMs: 3_000;
    readonly duplicateFailures: number;
    readonly lostWriteFailures: number;
    readonly isolationFailures: number;
  };
  readonly replicas: {
    readonly expectedMinimum: number;
    readonly observedCount: number;
    readonly replicaIdSha256s: readonly string[];
  };
  readonly journeys: {
    readonly writeCyclesAttempted: number;
    readonly writeCyclesCompleted: number;
    readonly writeRequests: number;
    readonly duplicateFailures: number;
    readonly lostWriteFailures: number;
    readonly isolationFailures: number;
  };
  readonly totals: {
    readonly requests: number;
    readonly http2xx: number;
    readonly http4xx: number;
    readonly http5xx: number;
    readonly otherHttp: number;
    readonly networkErrors: number;
    readonly timeouts: number;
    readonly contractFailures: number;
  };
  readonly routes: readonly LoadRouteReport[];
  readonly failureCodes: readonly LoadSoakRunFailureCode[];
}

export interface PermanentStagingLoadDependencies {
  readonly fetch: typeof globalThis.fetch;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly wallNow: () => number;
  readonly monotonicNow: () => number;
  readonly randomBytes: (size: number) => Buffer;
}

const DEFAULT_DEPENDENCIES: PermanentStagingLoadDependencies = {
  fetch: globalThis.fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
  randomBytes: (size) => crypto.randomBytes(size),
};

const MAX_EXPECTED_RPS = 4;
const MAX_PROFILE_RPS = 8;
const MAX_EXPECTED_CONCURRENCY = 8;
const MAX_PROFILE_CONCURRENCY = 16;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const HTTP_5XX_LIMIT_EXCLUSIVE = 0.01 as const;
const PUBLIC_P95_LIMIT_EXCLUSIVE_MS = 2_000 as const;
const ADMIN_P95_LIMIT_EXCLUSIVE_MS = 3_000 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const PLACEHOLDER_PATTERN = /(?:^|[._:-])(?:change[-_]?me|dummy|example|fake|fixture|placeholder|replace(?:[-_]?with)?|test)(?:$|[._:-])/i;
const TOKEN_PATTERN = /^\S{20,8192}$/;
const STAGING_HOST_TOKEN = /(?:^|[.-])staging(?:[.-]|$)/i;
const CANONICAL_PRODUCTION_HOSTS = new Set(["pintpath.au", "www.pintpath.au"]);
const TRACKED_BEERS = new Set(["Guinness", "Carlton Draught", "Stone & Wood Pacific Ale"]);
const SERVING_SIZES = new Set(["pint", "pot", "schooner", "jug", "bottle", "can", "other"]);
const TAP_STATUSES = new Set(["yes", "no", "unknown"]);

const FIXTURE_KEYS = [
  "beerName",
  "isOnTap",
  "price",
  "purpose",
  "reviewed",
  "schemaVersion",
  "servingSize",
  "suburb",
  "venueId",
  "venueName",
] as const;

const ROUTES = Object.freeze({
  health: { key: "GET /health", path: "/health", trafficClass: "public" as const },
  ready: { key: "GET /ready", path: "/ready", trafficClass: "public" as const },
  config: { key: "GET /api/business/config", path: "/api/business/config", trafficClass: "public" as const },
  venues: { key: "GET /api/business/venues", path: "/api/business/venues?limit=50&offset=0", trafficClass: "public" as const },
  prices: { key: "GET /api/business/price-records", path: "/api/business/price-records?limit=50&offset=0", trafficClass: "public" as const },
  access: { key: "GET /api/business/access", path: "/api/business/access", trafficClass: "public" as const },
  admin: { key: "GET /api/admin/status", path: "/api/admin/status", trafficClass: "admin" as const },
  account: { key: "GET /api/business/account", path: "/api/business/account", trafficClass: "authenticated_read" as const },
  write: { key: "POST /api/business/submissions", path: "/api/business/submissions", trafficClass: "authenticated_write" as const },
  submissions: { key: "GET /api/business/submissions", path: "/api/business/submissions?mine=true&limit=200&offset=0", trafficClass: "authenticated_read" as const },
});

const LOAD_ROUTE_PLAN = Object.freeze([
  ROUTES.health,
  ROUTES.config,
  ROUTES.venues,
  ROUTES.prices,
  ROUTES.access,
  ROUTES.venues,
  ROUTES.config,
  ROUTES.prices,
  ROUTES.admin,
  ROUTES.ready,
]);

export class LoadSoakConfigurationError extends Error {
  constructor(readonly code: LoadSoakConfigurationFailureCode) {
    super(code);
    this.name = "LoadSoakConfigurationError";
  }
}

class LoadSoakRunAbort extends Error {
  constructor(readonly code: LoadSoakRunFailureCode) {
    super(code);
    this.name = "LoadSoakRunAbort";
  }
}

function configurationError(code: LoadSoakConfigurationFailureCode): never {
  throw new LoadSoakConfigurationError(code);
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function permanentStagingIdentitySha256(input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
}): string {
  return crypto
    .createHash("sha256")
    .update("pintpath/permanent-staging-load-identity/v1\0", "utf8")
    .update(input.projectId, "utf8")
    .update("\0", "utf8")
    .update(input.environmentId, "utf8")
    .update("\0", "utf8")
    .update(input.serviceId, "utf8")
    .digest("hex");
}

function requiredRawIdentityValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name] ?? "";
  if (!value) configurationError("identity_pin_invalid");
  return value;
}

function requiredCredentialFile(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim() ?? "";
  if (!value) configurationError("credential_file_invalid");
  return path.resolve(value);
}

function parseFiniteNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIntegerInRange(value: string | undefined, minimum: number, maximum: number): number | null {
  const parsed = parseFiniteNumber(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function parseBareStagingOrigin(value: string | undefined): URL {
  let target: URL;
  try {
    target = new URL(value?.trim() ?? "");
  } catch {
    configurationError("target_invalid");
  }
  if (
    target.protocol !== "https:"
    || target.username
    || target.password
    || target.search
    || target.hash
    || (target.pathname !== "/" && target.pathname !== "")
    || !target.hostname
    || net.isIP(target.hostname) !== 0
    || CANONICAL_PRODUCTION_HOSTS.has(target.hostname.toLowerCase())
    || target.hostname.toLowerCase().endsWith(".pintpath.au")
  ) {
    configurationError("target_invalid");
  }
  return target;
}

function parseArguments(arguments_: readonly string[]): {
  profile: PermanentStagingLoadProfile;
  durationMinutes: number;
} {
  const supportedProfiles = new Set<PermanentStagingLoadProfile>(["expected-peak", "2x-peak", "soak"]);
  const seen = new Set<string>();
  let profile: PermanentStagingLoadProfile | null = null;
  let durationMinutes: number | null = null;
  for (const argument of arguments_) {
    if (argument.startsWith("--profile=")) {
      if (seen.has("profile")) configurationError("arguments_invalid");
      seen.add("profile");
      const value = argument.slice("--profile=".length) as PermanentStagingLoadProfile;
      if (!supportedProfiles.has(value)) configurationError("arguments_invalid");
      profile = value;
      continue;
    }
    if (argument.startsWith("--duration-minutes=")) {
      if (seen.has("duration")) configurationError("arguments_invalid");
      seen.add("duration");
      durationMinutes = parseIntegerInRange(argument.slice("--duration-minutes=".length), 1, 480);
      if (durationMinutes === null) configurationError("arguments_invalid");
      continue;
    }
    configurationError("arguments_invalid");
  }
  if (!profile || durationMinutes === null) configurationError("arguments_invalid");
  if (
    (profile === "soak" && durationMinutes < 60)
    || (profile !== "soak" && (durationMinutes < 5 || durationMinutes > 30))
  ) {
    configurationError("profile_bounds_invalid");
  }
  return { profile, durationMinutes };
}

function validIdentity(value: string): boolean {
  return SAFE_ID_PATTERN.test(value) && !PLACEHOLDER_PATTERN.test(value);
}

export function parsePermanentStagingLoadConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  arguments_: readonly string[],
): PermanentStagingLoadConfiguration {
  if (environment.PINTPATH_STAGING_LOAD_MUTATION?.trim() !== "confirmed") {
    configurationError("mutation_confirmation_missing");
  }
  if (environment.PINTPATH_STAGING_LOAD_DISPOSABLE_USERS?.trim() !== "confirmed") {
    configurationError("disposable_user_confirmation_missing");
  }
  if (isRestoreRehearsalEnvironment(environment.RESTORE_REHEARSAL_MODE, environment as NodeJS.ProcessEnv)) {
    configurationError("restore_mode_detected");
  }

  const { profile, durationMinutes } = parseArguments(arguments_);
  const target = parseBareStagingOrigin(environment.PINTPATH_STAGING_LOAD_BASE_URL);
  const expectedHostname = environment.PINTPATH_STAGING_LOAD_EXPECTED_HOSTNAME?.trim().toLowerCase() ?? "";
  if (
    !expectedHostname
    || target.hostname.toLowerCase() !== expectedHostname
    || !STAGING_HOST_TOKEN.test(expectedHostname)
  ) {
    configurationError("target_not_staging");
  }
  const targetOriginSha256 = sha256(target.origin);
  const expectedOriginSha256 = environment.PINTPATH_STAGING_LOAD_EXPECTED_ORIGIN_SHA256?.trim() ?? "";
  const productionOriginSha256 = environment.PINTPATH_STAGING_LOAD_PRODUCTION_ORIGIN_SHA256?.trim() ?? "";
  const restoreOriginSha256 = environment.PINTPATH_STAGING_LOAD_RESTORE_ORIGIN_SHA256?.trim() ?? "";
  if (
    !SHA256_PATTERN.test(expectedOriginSha256)
    || !SHA256_PATTERN.test(productionOriginSha256)
    || !SHA256_PATTERN.test(restoreOriginSha256)
  ) {
    configurationError("target_pin_invalid");
  }
  if (targetOriginSha256 !== expectedOriginSha256) configurationError("target_pin_mismatch");
  if ([productionOriginSha256, restoreOriginSha256].includes(targetOriginSha256)) {
    configurationError("target_is_forbidden");
  }
  if (new Set([expectedOriginSha256, productionOriginSha256, restoreOriginSha256]).size !== 3) {
    configurationError("target_pin_invalid");
  }

  const expectedCommitSha = environment.PINTPATH_STAGING_LOAD_EXPECTED_COMMIT_SHA?.trim() ?? "";
  if (!COMMIT_SHA_PATTERN.test(expectedCommitSha)) configurationError("commit_pin_invalid");

  const projectId = requiredRawIdentityValue(
    environment,
    "PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID",
  );
  const environmentId = requiredRawIdentityValue(
    environment,
    "PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID",
  );
  const serviceId = requiredRawIdentityValue(
    environment,
    "PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID",
  );
  const targetProjectIdSha256 = railwayDeploymentIdentityIdSha256("project", projectId);
  const targetEnvironmentIdSha256 = railwayDeploymentIdentityIdSha256("environment", environmentId);
  const targetServiceIdSha256 = railwayDeploymentIdentityIdSha256("service", serviceId);
  if (
    !validIdentity(projectId)
    || !validIdentity(environmentId)
    || !validIdentity(serviceId)
    || targetProjectIdSha256 === undefined
    || targetEnvironmentIdSha256 === undefined
    || targetServiceIdSha256 === undefined
  ) {
    configurationError("identity_pin_invalid");
  }
  const expectedIdentitySha256 = environment.PINTPATH_STAGING_LOAD_EXPECTED_IDENTITY_SHA256?.trim() ?? "";
  const actualIdentitySha256 = permanentStagingIdentitySha256({ projectId, environmentId, serviceId });
  if (
    !SHA256_PATTERN.test(expectedIdentitySha256)
    || actualIdentitySha256 !== expectedIdentitySha256
  ) configurationError("identity_pin_invalid");

  const expectedRps = parseFiniteNumber(environment.PINTPATH_STAGING_LOAD_EXPECTED_RPS);
  const expectedConcurrency = parseIntegerInRange(
    environment.PINTPATH_STAGING_LOAD_EXPECTED_CONCURRENCY,
    2,
    MAX_EXPECTED_CONCURRENCY,
  );
  const expectedReplicaCount = parseIntegerInRange(
    environment.PINTPATH_STAGING_LOAD_EXPECTED_REPLICA_COUNT,
    2,
    4,
  );
  const requestTimeoutMs = environment.PINTPATH_STAGING_LOAD_REQUEST_TIMEOUT_MS?.trim()
    ? parseIntegerInRange(environment.PINTPATH_STAGING_LOAD_REQUEST_TIMEOUT_MS, 1_000, 30_000)
    : 10_000;
  const writeIntervalSeconds = environment.PINTPATH_STAGING_LOAD_WRITE_INTERVAL_SECONDS?.trim()
    ? parseIntegerInRange(environment.PINTPATH_STAGING_LOAD_WRITE_INTERVAL_SECONDS, 120, 1_800)
    : 300;
  const writeConcurrency = environment.PINTPATH_STAGING_LOAD_WRITE_CONCURRENCY?.trim()
    ? parseIntegerInRange(environment.PINTPATH_STAGING_LOAD_WRITE_CONCURRENCY, 2, 6)
    : 4;
  if (
    expectedRps === null
    || expectedRps < 0.1
    || expectedRps > MAX_EXPECTED_RPS
    || expectedConcurrency === null
    || expectedReplicaCount === null
    || requestTimeoutMs === null
    || writeIntervalSeconds === null
    || writeConcurrency === null
  ) {
    configurationError("profile_bounds_invalid");
  }
  const multiplier = profile === "2x-peak" ? 2 : 1;
  const ratePerSecond = expectedRps * multiplier;
  const maxConcurrency = expectedConcurrency * multiplier;
  if (
    ratePerSecond > MAX_PROFILE_RPS
    || maxConcurrency > MAX_PROFILE_CONCURRENCY
    || writeConcurrency > maxConcurrency
  ) {
    configurationError("profile_bounds_invalid");
  }

  const userATokenFile = requiredCredentialFile(environment, "PINTPATH_STAGING_LOAD_USER_A_TOKEN_FILE");
  const userBTokenFile = requiredCredentialFile(environment, "PINTPATH_STAGING_LOAD_USER_B_TOKEN_FILE");
  const adminTokenFile = requiredCredentialFile(environment, "PINTPATH_STAGING_LOAD_ADMIN_TOKEN_FILE");
  const writeFixtureFile = requiredCredentialFile(environment, "PINTPATH_STAGING_LOAD_WRITE_FIXTURE_FILE");
  if (new Set([userATokenFile, userBTokenFile, adminTokenFile, writeFixtureFile]).size !== 4) {
    configurationError("credential_file_invalid");
  }
  const writeFixtureSha256 = environment.PINTPATH_STAGING_LOAD_WRITE_FIXTURE_SHA256?.trim() ?? "";
  if (!SHA256_PATTERN.test(writeFixtureSha256)) configurationError("fixture_pin_invalid");

  return {
    profile,
    durationMs: durationMinutes * 60_000,
    ratePerSecond,
    maxConcurrency,
    requestTimeoutMs,
    writeIntervalMs: writeIntervalSeconds * 1_000,
    writeConcurrency,
    expectedReplicaCount,
    targetOrigin: target.origin,
    targetOriginSha256,
    targetIdentitySha256: actualIdentitySha256,
    targetProjectIdSha256,
    targetEnvironmentIdSha256,
    targetServiceIdSha256,
    expectedCommitSha,
    userATokenFile,
    userBTokenFile,
    adminTokenFile,
    writeFixtureFile,
    writeFixtureSha256,
  };
}

export async function readPrivateOperatorFile(filename: string): Promise<Buffer> {
  const resolved = path.resolve(filename);
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    configurationError("credential_file_invalid");
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || stat.size < 1
      || stat.size > 64 * 1024
    ) {
      configurationError("credential_file_invalid");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseReviewedFixture(bytes: Buffer, expectedSha256: string): ReviewedLoadWriteFixture {
  if (sha256(bytes) !== expectedSha256) configurationError("fixture_pin_invalid");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    configurationError("fixture_pin_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) configurationError("fixture_pin_invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== FIXTURE_KEYS.length || keys.some((key, index) => key !== FIXTURE_KEYS[index])) {
    configurationError("fixture_pin_invalid");
  }
  const suburb = record.suburb;
  if (
    record.schemaVersion !== 1
    || record.purpose !== "permanent-staging-disposable-load"
    || record.reviewed !== true
    || typeof record.venueId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,119}$/.test(record.venueId)
    || typeof record.venueName !== "string"
    || record.venueName.trim() !== record.venueName
    || record.venueName.length < 1
    || record.venueName.length > 180
    || (suburb !== null && (typeof suburb !== "string" || suburb.trim() !== suburb || suburb.length < 1 || suburb.length > 120))
    || typeof record.beerName !== "string"
    || !TRACKED_BEERS.has(record.beerName)
    || typeof record.servingSize !== "string"
    || !SERVING_SIZES.has(record.servingSize)
    || typeof record.price !== "number"
    || !Number.isFinite(record.price)
    || record.price < 0.01
    || record.price > 100
    || Math.round(record.price * 100) !== record.price * 100
    || typeof record.isOnTap !== "string"
    || !TAP_STATUSES.has(record.isOnTap)
  ) {
    configurationError("fixture_pin_invalid");
  }
  return record as unknown as ReviewedLoadWriteFixture;
}

export async function loadPermanentStagingLoadSecrets(
  configuration: PermanentStagingLoadConfiguration,
  readFile: (filename: string) => Promise<Buffer> = readPrivateOperatorFile,
): Promise<PermanentStagingLoadSecrets> {
  const [userABytes, userBBytes, adminBytes, fixtureBytes] = await Promise.all([
    readFile(configuration.userATokenFile),
    readFile(configuration.userBTokenFile),
    readFile(configuration.adminTokenFile),
    readFile(configuration.writeFixtureFile),
  ]);
  const userAToken = userABytes.toString("utf8").trim();
  const userBToken = userBBytes.toString("utf8").trim();
  const adminToken = adminBytes.toString("utf8").trim();
  if (
    !TOKEN_PATTERN.test(userAToken)
    || !TOKEN_PATTERN.test(userBToken)
    || !TOKEN_PATTERN.test(adminToken)
    || new Set([sha256(userAToken), sha256(userBToken), sha256(adminToken)]).size !== 3
  ) {
    configurationError("credential_file_invalid");
  }
  return {
    userAToken,
    userBToken,
    adminToken,
    writeFixture: parseReviewedFixture(fixtureBytes, configuration.writeFixtureSha256),
  };
}

interface RouteDefinition {
  readonly key: string;
  readonly path: string;
  readonly trafficClass: LoadTrafficClass;
}

interface MutableRouteMetrics {
  readonly route: string;
  readonly trafficClass: LoadTrafficClass;
  requests: number;
  http2xx: number;
  http4xx: number;
  http5xx: number;
  otherHttp: number;
  networkErrors: number;
  timeouts: number;
  contractFailures: number;
  readonly successfulLatenciesMs: number[];
}

class LoadMetrics {
  private readonly byRoute = new Map<string, MutableRouteMetrics>();

  get(route: RouteDefinition): MutableRouteMetrics {
    const existing = this.byRoute.get(route.key);
    if (existing) return existing;
    const created: MutableRouteMetrics = {
      route: route.key,
      trafficClass: route.trafficClass,
      requests: 0,
      http2xx: 0,
      http4xx: 0,
      http5xx: 0,
      otherHttp: 0,
      networkErrors: 0,
      timeouts: 0,
      contractFailures: 0,
      successfulLatenciesMs: [],
    };
    this.byRoute.set(route.key, created);
    return created;
  }

  contractFailure(route: RouteDefinition): void {
    this.get(route).contractFailures += 1;
  }

  reports(): LoadRouteReport[] {
    return [...this.byRoute.values()]
      .sort((left, right) => left.route.localeCompare(right.route))
      .map((route) => ({
        route: route.route,
        trafficClass: route.trafficClass,
        requests: route.requests,
        http2xx: route.http2xx,
        http4xx: route.http4xx,
        http5xx: route.http5xx,
        otherHttp: route.otherHttp,
        networkErrors: route.networkErrors,
        timeouts: route.timeouts,
        contractFailures: route.contractFailures,
        latencyMs: latencySummary(route.successfulLatenciesMs),
      }));
  }

  classLatencies(trafficClass: LoadTrafficClass): number[] {
    return [...this.byRoute.values()]
      .filter((route) => route.trafficClass === trafficClass)
      .flatMap((route) => route.successfulLatenciesMs);
  }
}

export function percentile(samples: readonly number[], quantile: number): number | null {
  if (!samples.length || !Number.isFinite(quantile) || quantile < 0 || quantile > 1) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index] ?? null;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function latencySummary(samples: readonly number[]): LoadRouteReport["latencyMs"] {
  if (!samples.length) {
    return { samples: 0, min: null, mean: null, p50: null, p95: null, p99: null, max: null };
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const mean = samples.reduce((total, sample) => total + sample, 0) / samples.length;
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const p99 = percentile(samples, 0.99);
  return {
    samples: samples.length,
    min: rounded(min),
    mean: rounded(mean),
    p50: p50 === null ? null : rounded(p50),
    p95: p95 === null ? null : rounded(p95),
    p99: p99 === null ? null : rounded(p99),
    max: rounded(max),
  };
}

export function http5xxRatioPasses(http5xx: number, requests: number): boolean {
  return requests > 0
    && Number.isInteger(http5xx)
    && Number.isInteger(requests)
    && http5xx >= 0
    && requests >= http5xx
    && http5xx / requests < HTTP_5XX_LIMIT_EXCLUSIVE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nestedData(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) return null;
  return value.data;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const contentLength = Number(response.headers.get("content-length") ?? Number.NaN);
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new Error("response_not_json");
  if (Number.isFinite(contentLength) && (contentLength < 0 || contentLength > MAX_RESPONSE_BYTES)) {
    throw new Error("response_too_large");
  }
  if (!response.body) throw new Error("response_body_missing");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response_too_large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
}

interface RequestOutcome {
  readonly status: number;
  readonly payload: unknown | null;
  readonly successful: boolean;
}

interface RunContext {
  readonly configuration: PermanentStagingLoadConfiguration;
  readonly secrets: PermanentStagingLoadSecrets;
  readonly dependencies: PermanentStagingLoadDependencies;
  readonly metrics: LoadMetrics;
  readonly replicaDigests: Set<string>;
  readonly runId: string;
  readonly journeys: {
    writeCyclesAttempted: number;
    writeCyclesCompleted: number;
    writeRequests: number;
    duplicateFailures: number;
    lostWriteFailures: number;
    isolationFailures: number;
  };
}

function requestHeaders(token: string | undefined, closeConnection: boolean): Record<string, string> {
  return {
    accept: "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(closeConnection ? { connection: "close" } : {}),
  };
}

function requestTimedOut(error: unknown): boolean {
  return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
}

async function executeRequest(input: {
  context: RunContext;
  route: RouteDefinition;
  token?: string;
  method?: "GET" | "POST";
  body?: unknown;
  expectedStatuses?: readonly number[];
  closeConnection?: boolean;
}): Promise<RequestOutcome> {
  const { context, route } = input;
  const metric = context.metrics.get(route);
  metric.requests += 1;
  const started = context.dependencies.monotonicNow();
  const requestUrl = new URL(route.path, context.configuration.targetOrigin);
  if (requestUrl.origin !== context.configuration.targetOrigin) {
    metric.contractFailures += 1;
    return { status: 0, payload: null, successful: false };
  }
  try {
    const response = await context.dependencies.fetch(requestUrl, {
      method: input.method ?? "GET",
      headers: {
        ...requestHeaders(input.token, input.closeConnection === true),
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(context.configuration.requestTimeoutMs),
    });
    const latency = Math.max(0, context.dependencies.monotonicNow() - started);
    const status = response.status;
    if (status >= 200 && status < 300) metric.http2xx += 1;
    else if (status >= 400 && status < 500) metric.http4xx += 1;
    else if (status >= 500 && status < 600) metric.http5xx += 1;
    else metric.otherHttp += 1;

    const expectedStatuses = input.expectedStatuses ?? [200];
    if (!expectedStatuses.includes(status)) {
      await response.body?.cancel().catch(() => undefined);
      return { status, payload: null, successful: false };
    }
    let payload: unknown;
    try {
      payload = await readBoundedJson(response);
    } catch {
      metric.contractFailures += 1;
      return { status, payload: null, successful: false };
    }
    metric.successfulLatenciesMs.push(latency);
    return { status, payload, successful: true };
  } catch (error) {
    if (requestTimedOut(error)) metric.timeouts += 1;
    else metric.networkErrors += 1;
    return { status: 0, payload: null, successful: false };
  }
}

function validReplicaDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function validateDeploymentResponse(
  context: RunContext,
  route: RouteDefinition,
  outcome: RequestOutcome,
  expectedStatus: "ok" | "ready",
  preflight: boolean,
): void {
  if (!outcome.successful) {
    if (preflight) throw new LoadSoakRunAbort("target_preflight_failed");
    return;
  }
  const data = outcome.successful ? nestedData(outcome.payload) : null;
  const deployment = data && isRecord(data.deployment) ? data.deployment : null;
  const valid = Boolean(
    data
    && data.service === "pint-path"
    && data.status === expectedStatus
    && !Object.prototype.hasOwnProperty.call(data, "restoreRehearsal")
    && deployment
    && deployment.commitSha === context.configuration.expectedCommitSha
    && deployment.environment === "production"
    && deployment.projectIdSha256
      === context.configuration.targetProjectIdSha256
    && deployment.environmentIdSha256
      === context.configuration.targetEnvironmentIdSha256
    && deployment.serviceIdSha256
      === context.configuration.targetServiceIdSha256
    && validReplicaDigest(deployment.replicaIdSha256),
  );
  if (!valid || !deployment || !validReplicaDigest(deployment.replicaIdSha256)) {
    context.metrics.contractFailure(route);
    throw new LoadSoakRunAbort(preflight ? "target_preflight_failed" : "target_identity_changed");
  }
  context.replicaDigests.add(deployment.replicaIdSha256);
}

function validatePublicConfig(context: RunContext, outcome: RequestOutcome, preflight: boolean): void {
  if (!outcome.successful) {
    if (preflight) throw new LoadSoakRunAbort("target_preflight_failed");
    return;
  }
  const data = outcome.successful ? nestedData(outcome.payload) : null;
  const valid = Boolean(
    data
    && data.priceAccessModel === "fixed_preview"
    && data.happyHourDiscoveryEnabled === false
    && data.happyHourContributionsEnabled === false
    && data.consumerPaidEnrollmentEnabled === false
    && data.pintPointsRewardsEnabled === false
    && data.alcoholGamificationEnabled === false
    && data.demoBillingMode === false
    && data.fieldTestMode === false,
  );
  if (!valid) {
    context.metrics.contractFailure(ROUTES.config);
    throw new LoadSoakRunAbort(preflight ? "target_preflight_failed" : "target_identity_changed");
  }
}

function validateArrayField(
  context: RunContext,
  route: RouteDefinition,
  outcome: RequestOutcome,
  field: string,
): void {
  if (!outcome.successful) return;
  const data = outcome.successful ? nestedData(outcome.payload) : null;
  if (!data || !Array.isArray(data[field])) context.metrics.contractFailure(route);
}

function validateAccess(context: RunContext, outcome: RequestOutcome): void {
  if (!outcome.successful) return;
  const data = outcome.successful ? nestedData(outcome.payload) : null;
  if (!data || typeof data !== "object") context.metrics.contractFailure(ROUTES.access);
}

function validateAdminStatus(context: RunContext, outcome: RequestOutcome, preflight: boolean): void {
  if (!outcome.successful) {
    if (preflight) throw new LoadSoakRunAbort("target_preflight_failed");
    return;
  }
  const data = outcome.successful ? nestedData(outcome.payload) : null;
  const valid = Boolean(
    data
    && data.enabled === true
    && typeof data.ocrEnabled === "boolean"
    && typeof data.googlePlacesEnabled === "boolean"
    && typeof data.queueEnabled === "boolean",
  );
  if (!valid) {
    context.metrics.contractFailure(ROUTES.admin);
    if (preflight) throw new LoadSoakRunAbort("target_preflight_failed");
  }
}

async function executeLoadRoute(context: RunContext, route: RouteDefinition): Promise<void> {
  if (route === ROUTES.health) {
    const outcome = await executeRequest({ context, route, closeConnection: true });
    validateDeploymentResponse(context, route, outcome, "ok", false);
    return;
  }
  if (route === ROUTES.ready) {
    const outcome = await executeRequest({ context, route, closeConnection: true });
    validateDeploymentResponse(context, route, outcome, "ready", false);
    return;
  }
  if (route === ROUTES.config) {
    validatePublicConfig(context, await executeRequest({ context, route }), false);
    return;
  }
  if (route === ROUTES.venues) {
    validateArrayField(context, route, await executeRequest({ context, route }), "venues");
    return;
  }
  if (route === ROUTES.prices) {
    validateArrayField(context, route, await executeRequest({ context, route }), "records");
    return;
  }
  if (route === ROUTES.access) {
    validateAccess(context, await executeRequest({ context, route }));
    return;
  }
  if (route === ROUTES.admin) {
    validateAdminStatus(
      context,
      await executeRequest({ context, route, token: context.secrets.adminToken }),
      false,
    );
    return;
  }
  context.metrics.contractFailure(route);
}

function accountIdentity(outcome: RequestOutcome): { id: string; role: string } | null {
  const data = outcome.successful ? nestedData(outcome.payload) : null;
  const account = data && isRecord(data.account) ? data.account : null;
  return account && typeof account.id === "string" && typeof account.role === "string"
    ? { id: account.id, role: account.role }
    : null;
}

async function preflight(context: RunContext): Promise<void> {
  const health = await executeRequest({ context, route: ROUTES.health, closeConnection: true });
  validateDeploymentResponse(context, ROUTES.health, health, "ok", true);
  const ready = await executeRequest({ context, route: ROUTES.ready, closeConnection: true });
  validateDeploymentResponse(context, ROUTES.ready, ready, "ready", true);
  validatePublicConfig(context, await executeRequest({ context, route: ROUTES.config }), true);
  validateAdminStatus(
    context,
    await executeRequest({ context, route: ROUTES.admin, token: context.secrets.adminToken }),
    true,
  );
  const [userAResponse, userBResponse] = await Promise.all([
    executeRequest({ context, route: ROUTES.account, token: context.secrets.userAToken }),
    executeRequest({ context, route: ROUTES.account, token: context.secrets.userBToken }),
  ]);
  const userA = accountIdentity(userAResponse);
  const userB = accountIdentity(userBResponse);
  if (!userA || !userB || userA.role !== "user" || userB.role !== "user" || userA.id === userB.id) {
    context.metrics.contractFailure(ROUTES.account);
    throw new LoadSoakRunAbort("credential_scope_invalid");
  }
}

function submissionPayload(context: RunContext, clientSubmissionId: string): Record<string, unknown> {
  const fixture = context.secrets.writeFixture;
  return {
    clientSubmissionId,
    missionId: null,
    venueId: fixture.venueId,
    venueName: fixture.venueName,
    suburb: fixture.suburb,
    newVenue: null,
    submissionType: "single_beer_price",
    observedAt: new Date(context.dependencies.wallNow()).toISOString(),
    sourcePhotoDataUrl: null,
    sourcePhotoDataUrls: [],
    sourceDocumentDataUrl: null,
    sourcePhotoUrl: null,
    uploadLocation: null,
    notes: "Permanent-staging disposable-user load proof. Never publish.",
    items: [{
      beerName: fixture.beerName,
      servingSize: fixture.servingSize,
      price: fixture.price,
      isHappyHourPrice: false,
      happyHourDetails: null,
      isOnTap: fixture.isOnTap,
    }],
  };
}

function submissionResult(outcome: RequestOutcome): {
  id: string;
  clientSubmissionId: string;
  replay: boolean;
} | null {
  const data = outcome.successful ? nestedData(outcome.payload) : null;
  const submission = data && isRecord(data.submission) ? data.submission : null;
  return data && submission
    && typeof submission.id === "string"
    && typeof submission.clientSubmissionId === "string"
    ? {
        id: submission.id,
        clientSubmissionId: submission.clientSubmissionId,
        replay: data.idempotentReplay === true,
      }
    : null;
}

function listedSubmissions(outcome: RequestOutcome): Array<Record<string, unknown>> | null {
  const data = outcome.successful ? nestedData(outcome.payload) : null;
  if (!data || !Array.isArray(data.submissions)) return null;
  return data.submissions.filter(isRecord);
}

async function executeWriteJourney(context: RunContext, cycle: number): Promise<void> {
  context.journeys.writeCyclesAttempted += 1;
  const clientSubmissionId = `load-soak-${context.runId}-${String(cycle).padStart(4, "0")}`;
  const payload = submissionPayload(context, clientSubmissionId);
  const requests = Array.from({ length: context.configuration.writeConcurrency }, () => executeRequest({
    context,
    route: ROUTES.write,
    token: context.secrets.userAToken,
    method: "POST",
    body: payload,
    expectedStatuses: [200, 201],
  }));
  const outcomes = await Promise.all(requests);
  context.journeys.writeRequests += outcomes.length;
  const results = outcomes.map(submissionResult);
  const validResults = results.filter((result): result is NonNullable<typeof result> => Boolean(result));
  const createdCount = outcomes.filter((outcome) => outcome.status === 201).length;
  const replayCount = validResults.filter((result) => result.replay).length;
  const ids = new Set(validResults.map((result) => result.id));
  const responseContractValid = validResults.length === outcomes.length
    && validResults.every((result) => result.clientSubmissionId === clientSubmissionId)
    && createdCount === 1
    && replayCount === outcomes.length - 1
    && ids.size === 1;
  if (!responseContractValid) {
    context.metrics.contractFailure(ROUTES.write);
    if (ids.size > 1 || createdCount > 1 || replayCount !== outcomes.length - 1) {
      context.journeys.duplicateFailures += 1;
    }
    if (validResults.length !== outcomes.length || createdCount === 0) {
      context.journeys.lostWriteFailures += 1;
    }
    throw new LoadSoakRunAbort("write_journey_failed");
  }

  const [ownerResponse, isolatedResponse] = await Promise.all([
    executeRequest({ context, route: ROUTES.submissions, token: context.secrets.userAToken }),
    executeRequest({ context, route: ROUTES.submissions, token: context.secrets.userBToken }),
  ]);
  const ownerRows = listedSubmissions(ownerResponse);
  const isolatedRows = listedSubmissions(isolatedResponse);
  if (!ownerRows) {
    context.metrics.contractFailure(ROUTES.submissions);
    context.journeys.lostWriteFailures += 1;
    throw new LoadSoakRunAbort("write_journey_failed");
  }
  if (!isolatedRows) {
    context.metrics.contractFailure(ROUTES.submissions);
    context.journeys.isolationFailures += 1;
    throw new LoadSoakRunAbort("write_journey_failed");
  }
  const ownerMatches = ownerRows.filter((row) => row.clientSubmissionId === clientSubmissionId);
  const isolatedMatches = isolatedRows.filter((row) => row.clientSubmissionId === clientSubmissionId);
  const expectedId = validResults[0]?.id;
  if (ownerMatches.length > 1) {
    context.journeys.duplicateFailures += 1;
    throw new LoadSoakRunAbort("write_journey_failed");
  }
  if (ownerMatches.length !== 1 || ownerMatches[0]?.id !== expectedId) {
    context.journeys.lostWriteFailures += 1;
    throw new LoadSoakRunAbort("write_journey_failed");
  }
  if (isolatedMatches.length !== 0) {
    context.journeys.isolationFailures += 1;
    throw new LoadSoakRunAbort("write_journey_failed");
  }
  context.journeys.writeCyclesCompleted += 1;
}

async function settleInFlight(inFlight: Set<Promise<void>>): Promise<void> {
  if (inFlight.size) await Promise.all([...inFlight]);
}

async function executeTimedProfile(context: RunContext): Promise<void> {
  const startedAt = context.dependencies.wallNow();
  const deadline = startedAt + context.configuration.durationMs;
  const requestIntervalMs = 1_000 / context.configuration.ratePerSecond;
  let nextRequestAt = startedAt;
  let nextWriteAt = startedAt + context.configuration.writeIntervalMs;
  let routeIndex = 0;
  let writeCycle = 1;
  let fatal: LoadSoakRunAbort | null = null;
  const inFlight = new Set<Promise<void>>();

  while (context.dependencies.wallNow() < deadline && !fatal) {
    const now = context.dependencies.wallNow();
    if (now >= nextWriteAt) {
      await settleInFlight(inFlight);
      if (fatal) break;
      await executeWriteJourney(context, writeCycle);
      writeCycle += 1;
      nextWriteAt = context.dependencies.wallNow() + context.configuration.writeIntervalMs;
      nextRequestAt = context.dependencies.wallNow();
      continue;
    }
    if (inFlight.size >= context.configuration.maxConcurrency) {
      await Promise.race(inFlight);
      continue;
    }
    if (now < nextRequestAt) {
      await context.dependencies.sleep(Math.min(nextRequestAt - now, nextWriteAt - now, deadline - now));
      continue;
    }
    const route = LOAD_ROUTE_PLAN[routeIndex % LOAD_ROUTE_PLAN.length]!;
    routeIndex += 1;
    let task: Promise<void>;
    task = executeLoadRoute(context, route)
      .catch((error: unknown) => {
        fatal = error instanceof LoadSoakRunAbort ? error : new LoadSoakRunAbort("internal_failure");
      })
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
    nextRequestAt = context.dependencies.wallNow() + requestIntervalMs;
  }
  await settleInFlight(inFlight);
  if (fatal) throw fatal;
}

function aggregateTotals(routes: readonly LoadRouteReport[]): PermanentStagingLoadReport["totals"] {
  return routes.reduce<PermanentStagingLoadReport["totals"]>((totals, route) => ({
    requests: totals.requests + route.requests,
    http2xx: totals.http2xx + route.http2xx,
    http4xx: totals.http4xx + route.http4xx,
    http5xx: totals.http5xx + route.http5xx,
    otherHttp: totals.otherHttp + route.otherHttp,
    networkErrors: totals.networkErrors + route.networkErrors,
    timeouts: totals.timeouts + route.timeouts,
    contractFailures: totals.contractFailures + route.contractFailures,
  }), {
    requests: 0,
    http2xx: 0,
    http4xx: 0,
    http5xx: 0,
    otherHttp: 0,
    networkErrors: 0,
    timeouts: 0,
    contractFailures: 0,
  });
}

function buildReport(input: {
  context: RunContext;
  startedAt: number;
  completedAt: number;
  profileCompleted: boolean;
  abortCode: LoadSoakRunFailureCode | null;
}): PermanentStagingLoadReport {
  const { context } = input;
  const routes = context.metrics.reports();
  const totals = aggregateTotals(routes);
  const publicP95 = percentile(context.metrics.classLatencies("public"), 0.95);
  const adminP95 = percentile(context.metrics.classLatencies("admin"), 0.95);
  const http5xxRatio = totals.requests > 0 ? totals.http5xx / totals.requests : 1;
  const failures = new Set<LoadSoakRunFailureCode>();
  if (input.abortCode) failures.add(input.abortCode);
  if (!input.profileCompleted) failures.add("profile_incomplete");
  if (!http5xxRatioPasses(totals.http5xx, totals.requests)) failures.add("http_5xx_threshold_failed");
  if (publicP95 === null || publicP95 >= PUBLIC_P95_LIMIT_EXCLUSIVE_MS) {
    failures.add("public_p95_threshold_failed");
  }
  if (adminP95 === null || adminP95 >= ADMIN_P95_LIMIT_EXCLUSIVE_MS) {
    failures.add("admin_p95_threshold_failed");
  }
  if (totals.http4xx > 0 || totals.otherHttp > 0) failures.add("unexpected_http_failure");
  if (totals.networkErrors > 0) failures.add("network_failure");
  if (totals.timeouts > 0) failures.add("timeout_failure");
  if (totals.contractFailures > 0) failures.add("response_contract_failure");
  if (context.journeys.duplicateFailures > 0) failures.add("duplicate_write_failure");
  if (context.journeys.lostWriteFailures > 0) failures.add("lost_write_failure");
  if (context.journeys.isolationFailures > 0) failures.add("isolation_failure");
  if (context.replicaDigests.size < context.configuration.expectedReplicaCount) {
    failures.add("replica_participation_failed");
  }
  const replicaIdSha256s = [...context.replicaDigests].sort();
  const failureCodes = [...failures].sort();
  return {
    schemaVersion: 1,
    kind: "pintpath_permanent_staging_load_soak",
    passed: failureCodes.length === 0,
    profile: context.configuration.profile,
    startedAt: new Date(input.startedAt).toISOString(),
    completedAt: new Date(input.completedAt).toISOString(),
    configuredDurationSeconds: context.configuration.durationMs / 1_000,
    configuredRatePerSecond: context.configuration.ratePerSecond,
    configuredMaxConcurrency: context.configuration.maxConcurrency,
    requestTimeoutMs: context.configuration.requestTimeoutMs,
    targetOriginSha256: context.configuration.targetOriginSha256,
    targetIdentitySha256: context.configuration.targetIdentitySha256,
    writeFixtureSha256: context.configuration.writeFixtureSha256,
    expectedCommitSha: context.configuration.expectedCommitSha,
    thresholds: {
      http5xxRatio: Math.round(http5xxRatio * 1_000_000) / 1_000_000,
      http5xxLimitExclusive: HTTP_5XX_LIMIT_EXCLUSIVE,
      publicP95Ms: publicP95 === null ? null : rounded(publicP95),
      publicP95LimitExclusiveMs: PUBLIC_P95_LIMIT_EXCLUSIVE_MS,
      adminP95Ms: adminP95 === null ? null : rounded(adminP95),
      adminP95LimitExclusiveMs: ADMIN_P95_LIMIT_EXCLUSIVE_MS,
      duplicateFailures: context.journeys.duplicateFailures,
      lostWriteFailures: context.journeys.lostWriteFailures,
      isolationFailures: context.journeys.isolationFailures,
    },
    replicas: {
      expectedMinimum: context.configuration.expectedReplicaCount,
      observedCount: replicaIdSha256s.length,
      replicaIdSha256s,
    },
    journeys: { ...context.journeys },
    totals,
    routes,
    failureCodes,
  };
}

export async function runPermanentStagingLoadSoak(
  configuration: PermanentStagingLoadConfiguration,
  secrets: PermanentStagingLoadSecrets,
  overrides: Partial<PermanentStagingLoadDependencies> = {},
): Promise<PermanentStagingLoadReport> {
  const dependencies: PermanentStagingLoadDependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const startedAt = dependencies.wallNow();
  const context: RunContext = {
    configuration,
    secrets,
    dependencies,
    metrics: new LoadMetrics(),
    replicaDigests: new Set(),
    runId: dependencies.randomBytes(12).toString("hex"),
    journeys: {
      writeCyclesAttempted: 0,
      writeCyclesCompleted: 0,
      writeRequests: 0,
      duplicateFailures: 0,
      lostWriteFailures: 0,
      isolationFailures: 0,
    },
  };
  let abortCode: LoadSoakRunFailureCode | null = null;
  let profileCompleted = false;
  try {
    await preflight(context);
    await executeWriteJourney(context, 0);
    await executeTimedProfile(context);
    profileCompleted = true;
  } catch (error) {
    abortCode = error instanceof LoadSoakRunAbort ? error.code : "internal_failure";
  }
  return buildReport({
    context,
    startedAt,
    completedAt: dependencies.wallNow(),
    profileCompleted,
    abortCode,
  });
}

const CLI_USAGE = [
  "Usage: npm run staging:load:soak -- --profile=<expected-peak|2x-peak|soak> --duration-minutes=<N>",
  "",
  "The soak profile requires at least 60 minutes. Credentials must be supplied through owner-only files.",
].join("\n");

async function runCli(): Promise<0 | 1 | 2> {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(`${CLI_USAGE}\n`);
    return 0;
  }
  try {
    const configuration = parsePermanentStagingLoadConfiguration(process.env, process.argv.slice(2));
    const secrets = await loadPermanentStagingLoadSecrets(configuration);
    const report = await runPermanentStagingLoadSoak(configuration, secrets);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.passed ? 0 : 1;
  } catch (error) {
    const failureCode = error instanceof LoadSoakConfigurationError ? error.code : "internal_failure";
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      kind: "pintpath_permanent_staging_load_soak",
      passed: false,
      failureCodes: [failureCode],
    })}\n`);
    return error instanceof LoadSoakConfigurationError ? 2 : 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli();
}
