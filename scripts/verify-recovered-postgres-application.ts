import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolConfig, type QueryResultRow } from "pg";

import {
  parsePostgresAccountDeletionReplayReceipt,
  type PostgresAccountDeletionReplayReceipt,
} from "../src/lib/postgres-account-deletion-replay.js";
import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  openPostgresRailwayStockLocalhostCaTransport,
  parsePostgresRailwayStockLocalhostCaUrl,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import { redactKnownSecretValues } from "../src/lib/redact.js";
import {
  extractExactAppSessionCookie,
  readSetCookieHeaders,
} from "./lib/app-session-cookie.mjs";
import { parseStrictArguments } from "./lib/strict-arguments.js";
import { readTrustedRegularFile } from "./lib/trusted-filesystem.js";

const ARGUMENTS = new Set([
  "--app-port",
  "--auth-email-file",
  "--auth-password-file",
  "--candidate-sha",
  "--close-timeout-ms",
  "--compiled-artifact-root",
  "--database-resource-id",
  "--expected-auth-email-sha256",
  "--expected-auth-subject-sha256",
  "--expected-compiled-artifact-sha256",
  "--expected-compiled-entrypoint-sha256",
  "--expected-runtime-dependency-artifact-sha256",
  "--expected-maintenance-url-sha256",
  "--expected-redis-url-sha256",
  "--expected-root-ca-der-sha256",
  "--expected-runtime-url-sha256",
  "--expected-supabase-origin-sha256",
  "--expected-supabase-publishable-key-sha256",
  "--expected-target-identity-sha256",
  "--first-replay-receipt",
  "--maintenance-url-file",
  "--output-limit-bytes",
  "--permanent-staging-database-resource-id",
  "--permanent-staging-database-url-sha256",
  "--permanent-staging-railway-environment-id",
  "--permanent-staging-railway-project-id",
  "--permanent-staging-railway-service-id",
  "--permanent-staging-redis-resource-id",
  "--permanent-staging-redis-url-sha256",
  "--permanent-staging-supabase-publishable-key-sha256",
  "--production-database-resource-id",
  "--production-database-url-sha256",
  "--production-railway-environment-id",
  "--production-railway-project-id",
  "--production-railway-service-id",
  "--production-redis-resource-id",
  "--production-redis-url-sha256",
  "--production-supabase-publishable-key-sha256",
  "--railway-environment-id",
  "--railway-project-id",
  "--railway-service-id",
  "--redis-resource-id",
  "--redis-sentinel-file",
  "--redis-url-file",
  "--request-timeout-ms",
  "--runtime-stage-root",
  "--root-ca-file",
  "--runtime-url-file",
  "--second-replay-receipt",
  "--shutdown-timeout-ms",
  "--source-evidence-signing-secret-file",
  "--startup-timeout-ms",
  "--supabase-publishable-key-file",
  "--supabase-url",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE_SHA = /^[a-f0-9]{40}$/;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SUPABASE_ORIGIN = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/;
const SUPABASE_PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]{20,220}$/;
const RESOURCE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const UNSAFE_RESOURCE_IDENTITY =
  /(?:^|[._:-])(?:change[-_]?me|dummy|example|fake|fixture|placeholder|replace(?:[-_]?with)?|test)(?:$|[._:-])/i;
const CANONICAL_PRODUCTION_SUPABASE_ORIGIN = "https://auth.pintpath.au";
const PERMANENT_STAGING_SUPABASE_ORIGIN =
  "https://bbfibbadwjxzrcdncavy.supabase.co";
const OPERATIONAL_OFFSITE_SUPABASE_ORIGIN =
  "https://hfbmhdxrwtihukmixxta.supabase.co";
const REQUIRED_ARTIFACT_FILES = Object.freeze([
  "src/app.js",
  "src/config/env.js",
  "src/db/postgres-schema.sql",
  "src/db/schema.sql",
  "src/server.js",
  "viewer/index.html",
]);
const MAX_ARTIFACT_FILES = 2_000;
const MAX_ARTIFACT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_RUNTIME_DEPENDENCY_FILES = 20_000;
const MAX_RUNTIME_DEPENDENCY_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_LOCK_BYTES = 4 * 1024 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024;

interface SmokeRow extends QueryResultRow {
  readonly effectiveRole: string;
  readonly targetClass: string | null;
  readonly schemaVersion: string | null;
  readonly migrationState: string | null;
  readonly authoritativeTables: string;
  readonly runtimeOperationsUsage: boolean;
  readonly maintenanceApplicationUsage: boolean;
  readonly maintenanceOperationsUsage: boolean;
  readonly maintenanceUnexpectedMembership: boolean;
  readonly replayedRequestCount: string;
  readonly replayedCompletedCount: string;
  readonly replayedSuppressedCount: string;
  readonly replayedRecipientSecretCount: string;
  readonly replayedAuthSessionCount: string;
  readonly replayedActiveEvidenceCount: string;
}

interface MaintenanceRow extends QueryResultRow {
  readonly effectiveRole: string;
  readonly applicationUsage: boolean;
  readonly operationsUsage: boolean;
  readonly runtimeMembership: boolean;
  readonly unexpectedMembership: boolean;
}

interface RestoredAccountRow extends QueryResultRow {
  readonly id: string;
  readonly supabaseUserId: string | null;
  readonly email: string;
  readonly role: string;
  readonly subscriptionStatus: string;
  readonly status: string;
  readonly authProvider: string;
  readonly legalAcceptanceCurrent: boolean;
  readonly privacySettingsPresent: boolean;
  readonly activeVenueAssignmentCount: string;
}

interface LeakageRow extends QueryResultRow {
  readonly otherAccountEmailPresent: boolean;
}

interface SessionCleanupRow extends QueryResultRow {
  readonly userId: string;
  readonly providerSessionIdHash: string | null;
  readonly revoked: boolean;
}

export interface RecoveryIdentityBoundaryInput {
  readonly candidateSha: string;
  readonly runtimeUrl: string;
  readonly runtimeUrlSha256: string;
  readonly maintenanceUrl: string;
  readonly maintenanceUrlSha256: string;
  readonly redisUrl: string;
  readonly redisUrlSha256: string;
  readonly supabaseUrl: string;
  readonly supabaseOriginSha256: string;
  readonly supabasePublishableKeySha256: string;
  readonly expectedSupabasePublishableKeySha256: string;
  readonly productionSupabasePublishableKeySha256: string;
  readonly permanentStagingSupabasePublishableKeySha256: string;
  readonly railwayProjectId: string;
  readonly railwayEnvironmentId: string;
  readonly railwayServiceId: string;
  readonly productionRailwayProjectId: string;
  readonly productionRailwayEnvironmentId: string;
  readonly productionRailwayServiceId: string;
  readonly permanentStagingRailwayProjectId: string;
  readonly permanentStagingRailwayEnvironmentId: string;
  readonly permanentStagingRailwayServiceId: string;
  readonly databaseResourceId: string;
  readonly productionDatabaseResourceId: string;
  readonly permanentStagingDatabaseResourceId: string;
  readonly productionDatabaseUrlSha256: string;
  readonly permanentStagingDatabaseUrlSha256: string;
  readonly redisResourceId: string;
  readonly productionRedisResourceId: string;
  readonly permanentStagingRedisResourceId: string;
  readonly productionRedisUrlSha256: string;
  readonly permanentStagingRedisUrlSha256: string;
}

export interface ManagedRecoveryChild {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  removeListener(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

interface PoolBoundary {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: Row[] }>;
  end(): Promise<void>;
}

export interface RecoveryRuntimeStageBoundary {
  readonly directory: string;
  readonly nodeModulesRoot: string;
  readonly packageLockFile: string;
  assertExact(): void;
  close(): void;
}

export interface RecoveredApplicationDependencies {
  readonly createPool: (config: PoolConfig) => PoolBoundary;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly spawn: (
    executable: string,
    args: readonly string[],
    options: childProcess.SpawnOptions,
  ) => ManagedRecoveryChild;
  readonly openTransport: typeof openPostgresRailwayStockLocalhostCaTransport;
  readonly createRuntimeStageBoundary: (
    compiledArtifactRoot: string,
    runtimeStageRoot: string,
  ) => RecoveryRuntimeStageBoundary;
  readonly removeTemporaryDirectory: (directory: string) => void;
}

const DEFAULT_DEPENDENCIES: RecoveredApplicationDependencies = {
  createPool: (config) => new Pool(config),
  fetch: globalThis.fetch,
  now: () => new Date(),
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref();
    }),
  spawn: (executable, args, options) =>
    childProcess.spawn(
      executable,
      [...args],
      options,
    ) as unknown as ManagedRecoveryChild,
  openTransport: openPostgresRailwayStockLocalhostCaTransport,
  createRuntimeStageBoundary: createReviewedRuntimeStageBoundary,
  removeTemporaryDirectory: (directory) => fs.rmdirSync(directory),
};

interface LoadedReplayReceipt {
  readonly value: PostgresAccountDeletionReplayReceipt;
  readonly sha256: string;
}

interface ParsedAccessToken {
  readonly subject: string;
  readonly sessionId: string;
  readonly issuedAtSeconds: number;
  readonly expiresAtSeconds: number;
}

interface BoundedHttpResponse {
  readonly status: number;
  readonly body: Buffer;
  readonly setCookieHeaders: readonly string[];
}

interface CeremonyArguments {
  readonly candidateSha: string;
  readonly appPort: number;
  readonly closeTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly outputLimitBytes: number;
  readonly compiledArtifactRoot: string;
  readonly runtimeStageRoot: string;
  readonly expectedCompiledArtifactSha256: string;
  readonly expectedCompiledEntrypointSha256: string;
  readonly expectedRuntimeDependencyArtifactSha256: string;
  readonly expectedAuthEmailSha256: string;
  readonly expectedAuthSubjectSha256: string;
  readonly expectedRootCaDerSha256: string;
  readonly expectedTargetIdentitySha256: string;
  readonly expectedRuntimeUrlSha256: string;
  readonly expectedMaintenanceUrlSha256: string;
  readonly expectedRedisUrlSha256: string;
  readonly expectedSupabaseOriginSha256: string;
  readonly expectedSupabasePublishableKeySha256: string;
  readonly productionSupabasePublishableKeySha256: string;
  readonly permanentStagingSupabasePublishableKeySha256: string;
  readonly runtimeUrlFile: string;
  readonly maintenanceUrlFile: string;
  readonly redisUrlFile: string;
  readonly rootCaFile: string;
  readonly supabasePublishableKeyFile: string;
  readonly authEmailFile: string;
  readonly authPasswordFile: string;
  readonly redisSentinelFile: string;
  readonly sourceEvidenceSigningSecretFile: string;
  readonly firstReplayReceipt: string;
  readonly secondReplayReceipt: string;
  readonly supabaseUrl: string;
  readonly railwayProjectId: string;
  readonly railwayEnvironmentId: string;
  readonly railwayServiceId: string;
  readonly productionRailwayProjectId: string;
  readonly productionRailwayEnvironmentId: string;
  readonly productionRailwayServiceId: string;
  readonly permanentStagingRailwayProjectId: string;
  readonly permanentStagingRailwayEnvironmentId: string;
  readonly permanentStagingRailwayServiceId: string;
  readonly databaseResourceId: string;
  readonly productionDatabaseResourceId: string;
  readonly permanentStagingDatabaseResourceId: string;
  readonly productionDatabaseUrlSha256: string;
  readonly permanentStagingDatabaseUrlSha256: string;
  readonly redisResourceId: string;
  readonly productionRedisResourceId: string;
  readonly permanentStagingRedisResourceId: string;
  readonly productionRedisUrlSha256: string;
  readonly permanentStagingRedisUrlSha256: string;
}

function fail(code: string): never {
  throw new Error(`recovered_postgres_application_${code}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalTimestampAfter(now: Date, earlier?: string): string {
  const observed = now.getTime();
  if (!Number.isFinite(observed)) fail("clock_invalid");
  const minimum = earlier === undefined ? observed : Date.parse(earlier) + 1;
  return new Date(Math.max(observed, minimum)).toISOString();
}

function exactSha(value: string): string {
  if (!SHA256.test(value)) fail("arguments_invalid");
  return value;
}

function exactAbsolute(value: string): string {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.resolve(value) !== value ||
    value.includes("\0")
  )
    fail("arguments_invalid");
  return value;
}

function exactInteger(value: string, minimum: number, maximum: number): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) fail("arguments_invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail("arguments_invalid");
  }
  return parsed;
}

function exactUuid(value: string): string {
  if (!UUID.test(value)) fail("identity_invalid");
  return value;
}

function exactResourceIdentity(value: string): string {
  if (!RESOURCE_IDENTITY.test(value) || UNSAFE_RESOURCE_IDENTITY.test(value)) {
    fail("identity_invalid");
  }
  return value;
}

function exactRailwayResource(value: string, environmentId: string): string {
  exactResourceIdentity(value);
  const parts = value.split(":");
  if (
    parts.length !== 3 ||
    parts[0] !== "railway" ||
    parts[1] !== environmentId ||
    !parts[2] ||
    !UUID.test(parts[2])
  )
    fail("identity_invalid");
  return value;
}

function exactPrivateText(
  filename: string,
  minimumBytes: number,
  maximumBytes: number,
): string {
  const bytes = readTrustedRegularFile(exactAbsolute(filename), {
    minBytes: minimumBytes,
    maxBytes: maximumBytes,
    requireOwner: true,
    requirePrivate: true,
  });
  try {
    const value = bytes.toString("utf8");
    if (
      Buffer.from(value, "utf8").compare(bytes) !== 0 ||
      value.trim() !== value ||
      /[\r\n\0]/.test(value)
    )
      fail("secret_file_invalid");
    return value;
  } finally {
    bytes.fill(0);
  }
}

function loadReplayReceipt(filename: string): LoadedReplayReceipt {
  const bytes = readTrustedRegularFile(exactAbsolute(filename), {
    minBytes: 2,
    maxBytes: 256 * 1024,
    requireOwner: true,
    requirePrivate: true,
  });
  try {
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      fail("replay_receipt_invalid");
    }
    let parsed: PostgresAccountDeletionReplayReceipt;
    try {
      parsed = parsePostgresAccountDeletionReplayReceipt(value);
    } catch {
      fail("replay_receipt_invalid");
    }
    if (canonicalPostgresBackupJson(parsed) !== bytes.toString("utf8")) {
      fail("replay_receipt_invalid");
    }
    return { value: parsed, sha256: sha256(bytes) };
  } finally {
    bytes.fill(0);
  }
}

function parseArguments(argv: readonly string[]): CeremonyArguments {
  let values: ReadonlyMap<string, string>;
  try {
    values = parseStrictArguments(argv, {
      allowed: ARGUMENTS,
      required: ARGUMENTS,
    });
  } catch {
    fail("arguments_invalid");
  }
  const get = (name: string): string => values.get(name)!;
  const candidateSha = get("--candidate-sha");
  if (!CANDIDATE_SHA.test(candidateSha)) fail("arguments_invalid");
  return {
    candidateSha,
    appPort: exactInteger(get("--app-port"), 1_024, 65_535),
    closeTimeoutMs: exactInteger(get("--close-timeout-ms"), 1_000, 30_000),
    requestTimeoutMs: exactInteger(get("--request-timeout-ms"), 500, 10_000),
    shutdownTimeoutMs: exactInteger(
      get("--shutdown-timeout-ms"),
      12_000,
      30_000,
    ),
    startupTimeoutMs: exactInteger(get("--startup-timeout-ms"), 2_000, 180_000),
    outputLimitBytes: exactInteger(get("--output-limit-bytes"), 4_096, 262_144),
    compiledArtifactRoot: exactAbsolute(get("--compiled-artifact-root")),
    runtimeStageRoot: exactAbsolute(get("--runtime-stage-root")),
    expectedCompiledArtifactSha256: exactSha(
      get("--expected-compiled-artifact-sha256"),
    ),
    expectedCompiledEntrypointSha256: exactSha(
      get("--expected-compiled-entrypoint-sha256"),
    ),
    expectedRuntimeDependencyArtifactSha256: exactSha(
      get("--expected-runtime-dependency-artifact-sha256"),
    ),
    expectedAuthEmailSha256: exactSha(get("--expected-auth-email-sha256")),
    expectedAuthSubjectSha256: exactSha(get("--expected-auth-subject-sha256")),
    expectedRootCaDerSha256: exactSha(get("--expected-root-ca-der-sha256")),
    expectedTargetIdentitySha256: exactSha(
      get("--expected-target-identity-sha256"),
    ),
    expectedRuntimeUrlSha256: exactSha(get("--expected-runtime-url-sha256")),
    expectedMaintenanceUrlSha256: exactSha(
      get("--expected-maintenance-url-sha256"),
    ),
    expectedRedisUrlSha256: exactSha(get("--expected-redis-url-sha256")),
    expectedSupabaseOriginSha256: exactSha(
      get("--expected-supabase-origin-sha256"),
    ),
    expectedSupabasePublishableKeySha256: exactSha(
      get("--expected-supabase-publishable-key-sha256"),
    ),
    productionSupabasePublishableKeySha256: exactSha(
      get("--production-supabase-publishable-key-sha256"),
    ),
    permanentStagingSupabasePublishableKeySha256: exactSha(
      get("--permanent-staging-supabase-publishable-key-sha256"),
    ),
    runtimeUrlFile: exactAbsolute(get("--runtime-url-file")),
    maintenanceUrlFile: exactAbsolute(get("--maintenance-url-file")),
    redisUrlFile: exactAbsolute(get("--redis-url-file")),
    rootCaFile: exactAbsolute(get("--root-ca-file")),
    supabasePublishableKeyFile: exactAbsolute(
      get("--supabase-publishable-key-file"),
    ),
    authEmailFile: exactAbsolute(get("--auth-email-file")),
    authPasswordFile: exactAbsolute(get("--auth-password-file")),
    redisSentinelFile: exactAbsolute(get("--redis-sentinel-file")),
    sourceEvidenceSigningSecretFile: exactAbsolute(
      get("--source-evidence-signing-secret-file"),
    ),
    firstReplayReceipt: exactAbsolute(get("--first-replay-receipt")),
    secondReplayReceipt: exactAbsolute(get("--second-replay-receipt")),
    supabaseUrl: get("--supabase-url"),
    railwayProjectId: get("--railway-project-id"),
    railwayEnvironmentId: get("--railway-environment-id"),
    railwayServiceId: get("--railway-service-id"),
    productionRailwayProjectId: get("--production-railway-project-id"),
    productionRailwayEnvironmentId: get("--production-railway-environment-id"),
    productionRailwayServiceId: get("--production-railway-service-id"),
    permanentStagingRailwayProjectId: get(
      "--permanent-staging-railway-project-id",
    ),
    permanentStagingRailwayEnvironmentId: get(
      "--permanent-staging-railway-environment-id",
    ),
    permanentStagingRailwayServiceId: get(
      "--permanent-staging-railway-service-id",
    ),
    databaseResourceId: get("--database-resource-id"),
    productionDatabaseResourceId: get("--production-database-resource-id"),
    permanentStagingDatabaseResourceId: get(
      "--permanent-staging-database-resource-id",
    ),
    productionDatabaseUrlSha256: exactSha(
      get("--production-database-url-sha256"),
    ),
    permanentStagingDatabaseUrlSha256: exactSha(
      get("--permanent-staging-database-url-sha256"),
    ),
    redisResourceId: get("--redis-resource-id"),
    productionRedisResourceId: get("--production-redis-resource-id"),
    permanentStagingRedisResourceId: get(
      "--permanent-staging-redis-resource-id",
    ),
    productionRedisUrlSha256: exactSha(get("--production-redis-url-sha256")),
    permanentStagingRedisUrlSha256: exactSha(
      get("--permanent-staging-redis-url-sha256"),
    ),
  };
}

function assertDistinct(
  values: readonly string[],
  code = "identity_reused",
): void {
  if (new Set(values).size !== values.length) fail(code);
}

export function assertRecoveryIdentityBoundary(
  input: RecoveryIdentityBoundaryInput,
): void {
  if (!CANDIDATE_SHA.test(input.candidateSha)) fail("candidate_mismatch");
  for (const digest of [
    input.runtimeUrlSha256,
    input.maintenanceUrlSha256,
    input.redisUrlSha256,
    input.supabaseOriginSha256,
    input.supabasePublishableKeySha256,
    input.expectedSupabasePublishableKeySha256,
    input.productionSupabasePublishableKeySha256,
    input.permanentStagingSupabasePublishableKeySha256,
    input.productionDatabaseUrlSha256,
    input.permanentStagingDatabaseUrlSha256,
    input.productionRedisUrlSha256,
    input.permanentStagingRedisUrlSha256,
  ])
    exactSha(digest);

  if (
    sha256(input.runtimeUrl) !== input.runtimeUrlSha256 ||
    sha256(input.maintenanceUrl) !== input.maintenanceUrlSha256 ||
    sha256(input.redisUrl) !== input.redisUrlSha256 ||
    sha256(input.supabaseUrl) !== input.supabaseOriginSha256 ||
    input.supabasePublishableKeySha256 !==
      input.expectedSupabasePublishableKeySha256
  )
    fail("identity_pin_mismatch");
  assertDistinct(
    [
      input.runtimeUrlSha256,
      input.maintenanceUrlSha256,
      input.productionDatabaseUrlSha256,
      input.permanentStagingDatabaseUrlSha256,
    ],
    "database_identity_reused",
  );
  assertDistinct(
    [
      input.redisUrlSha256,
      input.productionRedisUrlSha256,
      input.permanentStagingRedisUrlSha256,
    ],
    "redis_identity_reused",
  );
  assertDistinct(
    [
      input.supabasePublishableKeySha256,
      input.productionSupabasePublishableKeySha256,
      input.permanentStagingSupabasePublishableKeySha256,
    ],
    "supabase_credential_reused",
  );

  let runtime: URL;
  let maintenance: URL;
  let redis: URL;
  try {
    runtime = new URL(input.runtimeUrl);
    maintenance = new URL(input.maintenanceUrl);
    redis = new URL(input.redisUrl);
    parsePostgresRailwayStockLocalhostCaUrl(input.runtimeUrl);
    parsePostgresRailwayStockLocalhostCaUrl(input.maintenanceUrl);
  } catch {
    fail("connection_identity_invalid");
  }
  if (
    runtime.protocol !== maintenance.protocol ||
    runtime.hostname !== maintenance.hostname ||
    runtime.port !== "5432" ||
    maintenance.port !== "5432" ||
    runtime.pathname !== maintenance.pathname ||
    !runtime.username ||
    !maintenance.username ||
    decodeURIComponent(runtime.username) ===
      decodeURIComponent(maintenance.username)
  )
    fail("database_role_boundary_invalid");
  if (
    !["redis:", "rediss:"].includes(redis.protocol) ||
    !redis.hostname ||
    !redis.username ||
    !redis.password ||
    redis.hash
  )
    fail("redis_identity_invalid");

  const supabaseMatch = input.supabaseUrl.match(SUPABASE_ORIGIN);
  if (
    !supabaseMatch ||
    [
      CANONICAL_PRODUCTION_SUPABASE_ORIGIN,
      PERMANENT_STAGING_SUPABASE_ORIGIN,
      OPERATIONAL_OFFSITE_SUPABASE_ORIGIN,
    ].includes(input.supabaseUrl)
  )
    fail("supabase_identity_invalid");

  const targetRailway = [
    exactUuid(input.railwayProjectId),
    exactUuid(input.railwayEnvironmentId),
    exactUuid(input.railwayServiceId),
  ];
  const productionRailway = [
    exactUuid(input.productionRailwayProjectId),
    exactUuid(input.productionRailwayEnvironmentId),
    exactUuid(input.productionRailwayServiceId),
  ];
  const stagingRailway = [
    exactUuid(input.permanentStagingRailwayProjectId),
    exactUuid(input.permanentStagingRailwayEnvironmentId),
    exactUuid(input.permanentStagingRailwayServiceId),
  ];
  assertDistinct(
    [...targetRailway, ...productionRailway, ...stagingRailway],
    "railway_identity_reused",
  );

  exactRailwayResource(input.databaseResourceId, input.railwayEnvironmentId);
  exactRailwayResource(
    input.productionDatabaseResourceId,
    input.productionRailwayEnvironmentId,
  );
  exactRailwayResource(
    input.permanentStagingDatabaseResourceId,
    input.permanentStagingRailwayEnvironmentId,
  );
  exactRailwayResource(input.redisResourceId, input.railwayEnvironmentId);
  exactRailwayResource(
    input.productionRedisResourceId,
    input.productionRailwayEnvironmentId,
  );
  exactRailwayResource(
    input.permanentStagingRedisResourceId,
    input.permanentStagingRailwayEnvironmentId,
  );
  assertDistinct(
    [
      input.databaseResourceId,
      input.productionDatabaseResourceId,
      input.permanentStagingDatabaseResourceId,
    ],
    "database_resource_reused",
  );
  assertDistinct(
    [
      input.redisResourceId,
      input.productionRedisResourceId,
      input.permanentStagingRedisResourceId,
    ],
    "redis_resource_reused",
  );
}

function assertTrustedArtifactDirectory(directory: string): void {
  const stat = fs.lstatSync(directory, { bigint: true });
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (
    !Number.isSafeInteger(uid) ||
    uid === undefined ||
    uid < 0 ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== BigInt(uid) ||
    (stat.mode & 0o022n) !== 0n ||
    fs.realpathSync(directory) !== directory
  )
    fail("compiled_artifact_unsafe");
}

function hashCompiledApplicationArtifactInternal(
  rootInput: string,
  allowStagedRuntimeDependencies: boolean,
): string {
  const root = exactAbsolute(rootInput);
  if (path.basename(root) !== "dist") fail("compiled_artifact_unsafe");
  assertTrustedArtifactDirectory(root);
  const entries: Array<{
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }> = [];
  let totalBytes = 0;
  const walk = (directory: string): void => {
    assertTrustedArtifactDirectory(directory);
    const names = fs
      .readdirSync(directory)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const name of names) {
      if (!name || name === "." || name === ".." || name.includes("\0")) {
        fail("compiled_artifact_unsafe");
      }
      if (directory === root && name === "node_modules") {
        if (!allowStagedRuntimeDependencies) fail("compiled_artifact_unsafe");
        continue;
      }
      const filename = path.join(directory, name);
      const stat = fs.lstatSync(filename, { bigint: true });
      if (stat.isSymbolicLink()) fail("compiled_artifact_unsafe");
      if (stat.isDirectory()) {
        walk(filename);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n) {
        fail("compiled_artifact_unsafe");
      }
      const bytes = readTrustedRegularFile(filename, {
        minBytes: 0,
        maxBytes: MAX_ARTIFACT_FILE_BYTES,
        requireOwner: true,
      });
      totalBytes += bytes.length;
      if (
        entries.length >= MAX_ARTIFACT_FILES ||
        totalBytes > MAX_ARTIFACT_TOTAL_BYTES
      ) {
        bytes.fill(0);
        fail("compiled_artifact_unsafe");
      }
      entries.push({
        path: path.relative(root, filename).split(path.sep).join("/"),
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
      bytes.fill(0);
    }
  };
  walk(root);
  const observed = new Set(entries.map((entry) => entry.path));
  if (REQUIRED_ARTIFACT_FILES.some((required) => !observed.has(required))) {
    fail("compiled_artifact_incomplete");
  }
  return sha256(
    canonicalPostgresBackupJson({
      kind: "pintpath-compiled-application-artifact",
      version: 1,
      files: entries,
    }),
  );
}

export function hashCompiledApplicationArtifact(rootInput: string): string {
  return hashCompiledApplicationArtifactInternal(rootInput, false);
}

function exactArtifactStat(
  expected: fs.BigIntStats,
  observed: fs.BigIntStats,
): boolean {
  return (
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.uid === observed.uid &&
    expected.gid === observed.gid &&
    expected.mode === observed.mode &&
    expected.nlink === observed.nlink &&
    expected.size === observed.size &&
    expected.mtimeNs === observed.mtimeNs &&
    expected.ctimeNs === observed.ctimeNs &&
    expected.isFile() === observed.isFile() &&
    expected.isDirectory() === observed.isDirectory()
  );
}

function exactArtifactIdentity(
  expected: fs.BigIntStats,
  observed: fs.BigIntStats,
): boolean {
  return (
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.uid === observed.uid &&
    expected.gid === observed.gid &&
    expected.mode === observed.mode &&
    expected.isFile() === observed.isFile() &&
    expected.isDirectory() === observed.isDirectory()
  );
}

function exactArtifactObject(
  expected: fs.BigIntStats,
  observed: fs.BigIntStats,
): boolean {
  return (
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.uid === observed.uid &&
    expected.gid === observed.gid &&
    expected.isFile() === observed.isFile() &&
    expected.isDirectory() === observed.isDirectory()
  );
}

interface StagedArtifactNode {
  readonly relativePath: string;
  readonly type: "directory" | "file";
  readonly stat: fs.BigIntStats;
  readonly sha256?: string;
}

interface StagedArtifactSnapshot {
  readonly containerRoot: string;
  readonly destinationRoot: string;
  readonly containerDescriptor: number;
  readonly containerStat: fs.BigIntStats;
  readonly nodes: readonly StagedArtifactNode[];
  readonly artifactSha256: string;
  readonly runtimeDependencyArtifactSha256: string;
  readonly runtimeDependencyPackageLockSha256: string;
  readonly runtimeDependencyPackages: readonly RuntimeDependencyPackage[];
  readonly runtimeDependencyPackageCount: number;
  readonly runtimeDependencyFileCount: number;
  readonly runtimeDependencyBytes: number;
}

interface RuntimeDependencyPackage {
  readonly path: string;
  readonly version: string;
  readonly integrity: string | null;
  readonly optional: boolean;
}

interface RuntimeDependencyInventory {
  readonly artifactSha256: string;
  readonly packageLockSha256: string;
  readonly packages: readonly RuntimeDependencyPackage[];
  readonly files: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly totalBytes: number;
}

function openHeldArtifactDirectory(directory: string): {
  readonly descriptor: number;
  readonly stat: fs.BigIntStats;
} {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
    const pathStat = fs.lstatSync(directory, { bigint: true });
    if (
      !descriptorStat.isDirectory() ||
      descriptorStat.isSymbolicLink() ||
      !exactArtifactStat(descriptorStat, pathStat) ||
      fs.realpathSync(directory) !== directory
    )
      fail("compiled_artifact_stage_unsafe");
    return { descriptor, stat: descriptorStat };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function assertHeldArtifactDirectory(
  directory: string,
  descriptor: number,
  expected: fs.BigIntStats,
): void {
  const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
  const pathStat = fs.lstatSync(directory, { bigint: true });
  if (
    !exactArtifactIdentity(expected, descriptorStat) ||
    !exactArtifactStat(descriptorStat, pathStat) ||
    fs.realpathSync(directory) !== directory
  )
    fail("compiled_artifact_stage_ambiguous");
}

function assertReviewedRuntimeDirectory(
  directory: string,
  descriptor: number,
  expected: fs.BigIntStats,
): void {
  assertHeldArtifactDirectory(directory, descriptor, expected);
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (
    !Number.isSafeInteger(uid) ||
    uid === undefined ||
    uid < 0 ||
    expected.uid !== BigInt(uid) ||
    (expected.mode & 0o022n) !== 0n
  )
    fail("runtime_dependency_boundary_unsafe");
}

export function createReviewedRuntimeStageBoundary(
  compiledArtifactRootInput: string,
  runtimeStageRootInput: string,
): RecoveryRuntimeStageBoundary {
  const compiledArtifactRoot = exactAbsolute(compiledArtifactRootInput);
  const workspaceRoot = path.dirname(compiledArtifactRoot);
  const currentWorkspaceRoot = fs.realpathSync(process.cwd());
  const runtimeStageRoot = exactAbsolute(runtimeStageRootInput);
  const nodeModulesRoot = path.join(workspaceRoot, "node_modules");
  const packageLockFile = path.join(workspaceRoot, "package-lock.json");
  if (
    path.basename(compiledArtifactRoot) !== "dist" ||
    workspaceRoot !== currentWorkspaceRoot ||
    runtimeStageRoot === workspaceRoot ||
    runtimeStageRoot.startsWith(`${workspaceRoot}${path.sep}`) ||
    workspaceRoot.startsWith(`${runtimeStageRoot}${path.sep}`)
  )
    fail("runtime_dependency_boundary_unsafe");

  const workspace = openHeldArtifactDirectory(workspaceRoot);
  const stageParent = openHeldArtifactDirectory(runtimeStageRoot);
  const resolutionAncestors: Array<{
    readonly directory: string;
    readonly descriptor: number;
    readonly stat: fs.BigIntStats;
  }> = [];
  let nodeModules: ReturnType<typeof openHeldArtifactDirectory> | null = null;
  let stageDirectory: string | null = null;
  try {
    let ancestor = runtimeStageRoot;
    while (true) {
      const held = openHeldArtifactDirectory(ancestor);
      resolutionAncestors.push({ directory: ancestor, ...held });
      if (fs.existsSync(path.join(ancestor, "node_modules"))) {
        fail("runtime_dependency_resolution_boundary_unsafe");
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    nodeModules = openHeldArtifactDirectory(nodeModulesRoot);
    stageDirectory = fs.realpathSync(
      fs.mkdtempSync(path.join(runtimeStageRoot, "pintpath-recovered-app-")),
    );
    fs.chmodSync(stageDirectory, 0o700);
    const stageStat = fs.lstatSync(stageDirectory, { bigint: true });
    const workspaceStat = fs.fstatSync(workspace.descriptor, { bigint: true });
    const workspacePathStat = fs.lstatSync(workspaceRoot, { bigint: true });
    const nodeModulesStat = fs.fstatSync(nodeModules.descriptor, {
      bigint: true,
    });
    const nodeModulesPathStat = fs.lstatSync(nodeModulesRoot, { bigint: true });
    const uid = process.geteuid?.() ?? process.getuid?.();
    if (
      !Number.isSafeInteger(uid) ||
      uid === undefined ||
      uid < 0 ||
      !exactArtifactStat(workspaceStat, workspacePathStat) ||
      !exactArtifactStat(nodeModulesStat, nodeModulesPathStat) ||
      stageStat.uid !== BigInt(uid) ||
      !stageStat.isDirectory() ||
      stageStat.isSymbolicLink() ||
      (stageStat.mode & 0o777n) !== 0o700n ||
      path.dirname(stageDirectory) !== runtimeStageRoot
    )
      fail("runtime_dependency_boundary_unsafe");
    assertReviewedRuntimeDirectory(
      workspaceRoot,
      workspace.descriptor,
      workspaceStat,
    );
    assertReviewedRuntimeDirectory(
      nodeModulesRoot,
      nodeModules.descriptor,
      nodeModulesStat,
    );
    assertReviewedRuntimeDirectory(
      runtimeStageRoot,
      stageParent.descriptor,
      stageParent.stat,
    );

    const closeDescriptors = (): void => {
      const descriptors = new Set<number>([
        nodeModules!.descriptor,
        stageParent.descriptor,
        workspace.descriptor,
        ...resolutionAncestors.map((held) => held.descriptor),
      ]);
      for (const descriptor of descriptors) fs.closeSync(descriptor);
    };
    let closed = false;
    return {
      directory: stageDirectory,
      nodeModulesRoot,
      packageLockFile,
      assertExact: () => {
        if (closed) fail("runtime_dependency_boundary_unsafe");
        assertReviewedRuntimeDirectory(
          workspaceRoot,
          workspace.descriptor,
          workspaceStat,
        );
        assertReviewedRuntimeDirectory(
          nodeModulesRoot,
          nodeModules!.descriptor,
          nodeModulesStat,
        );
        assertReviewedRuntimeDirectory(
          runtimeStageRoot,
          stageParent.descriptor,
          stageParent.stat,
        );
        for (const held of resolutionAncestors) {
          assertHeldArtifactDirectory(
            held.directory,
            held.descriptor,
            held.stat,
          );
          if (fs.existsSync(path.join(held.directory, "node_modules"))) {
            fail("runtime_dependency_resolution_boundary_unsafe");
          }
        }
        const observedStage = fs.lstatSync(stageDirectory!, { bigint: true });
        if (
          !exactArtifactIdentity(stageStat, observedStage) ||
          fs.realpathSync(stageDirectory!) !== stageDirectory ||
          path.dirname(stageDirectory!) !== runtimeStageRoot
        )
          fail("runtime_dependency_boundary_unsafe");
      },
      close: () => {
        if (closed) return;
        closed = true;
        closeDescriptors();
      },
    };
  } catch (error) {
    if (stageDirectory !== null && fs.existsSync(stageDirectory)) {
      try {
        fs.rmdirSync(stageDirectory);
      } catch {
        // Preserve the original fail-closed error; the reviewed caller never populated this path.
      }
    }
    const descriptors = new Set<number>([
      ...(nodeModules === null ? [] : [nodeModules.descriptor]),
      stageParent.descriptor,
      workspace.descriptor,
      ...resolutionAncestors.map((held) => held.descriptor),
    ]);
    for (const descriptor of descriptors) fs.closeSync(descriptor);
    throw error;
  }
}

function runtimeDependencyPackages(packageLockFileInput: string): {
  readonly packageLockSha256: string;
  readonly packages: readonly RuntimeDependencyPackage[];
  readonly topLevelPackagePaths: readonly string[];
} {
  const packageLockFile = exactAbsolute(packageLockFileInput);
  if (path.basename(packageLockFile) !== "package-lock.json") {
    fail("runtime_dependency_manifest_invalid");
  }
  const bytes = readTrustedRegularFile(packageLockFile, {
    minBytes: 2,
    maxBytes: MAX_PACKAGE_LOCK_BYTES,
    requireOwner: true,
  });
  try {
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      fail("runtime_dependency_manifest_invalid");
    }
    if (
      !isRecord(decoded) ||
      decoded.lockfileVersion !== 3 ||
      !isRecord(decoded.packages) ||
      !isRecord(decoded.packages[""])
    ) {
      fail("runtime_dependency_manifest_invalid");
    }
    const rootDependencies = decoded.packages[""].dependencies;
    if (
      !isRecord(rootDependencies) ||
      Object.keys(rootDependencies).length === 0
    ) {
      fail("runtime_dependency_manifest_invalid");
    }
    const packages: RuntimeDependencyPackage[] = [];
    for (const [packagePath, value] of Object.entries(decoded.packages)) {
      if (
        !packagePath.startsWith("node_modules/") ||
        !isRecord(value) ||
        value.dev === true ||
        value.link === true
      ) {
        continue;
      }
      const normalized = packagePath.split("/").join(path.sep);
      if (
        packagePath.includes("\\") ||
        packagePath.includes("\0") ||
        path.posix.normalize(packagePath) !== packagePath ||
        !/^node_modules\/(?:@[-A-Za-z0-9._]+\/)?[-A-Za-z0-9._]+(?:\/node_modules\/(?:@[-A-Za-z0-9._]+\/)?[-A-Za-z0-9._]+)*$/.test(
          packagePath,
        ) ||
        normalized.split(path.sep).includes("..") ||
        typeof value.version !== "string" ||
        !/^[^\s\0]{1,200}$/.test(value.version) ||
        (value.integrity !== undefined &&
          (typeof value.integrity !== "string" ||
            !/^sha(?:256|384|512)-[A-Za-z0-9+/=]{20,500}$/.test(
              value.integrity,
            ))) ||
        (value.optional !== undefined && typeof value.optional !== "boolean")
      ) {
        fail("runtime_dependency_manifest_invalid");
      }
      packages.push({
        path: packagePath,
        version: value.version,
        integrity: value.integrity ?? null,
        optional: value.optional === true,
      });
    }
    packages.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    if (packages.length === 0 || packages.length > 2_000) {
      fail("runtime_dependency_manifest_invalid");
    }
    const packagePaths = new Set(packages.map((entry) => entry.path));
    for (const dependencyName of Object.keys(rootDependencies)) {
      if (
        !/^(@[-A-Za-z0-9._]+\/)?[-A-Za-z0-9._]+$/.test(dependencyName) ||
        !packagePaths.has(`node_modules/${dependencyName}`)
      ) {
        fail("runtime_dependency_manifest_invalid");
      }
    }
    const topLevelPackagePaths = packages
      .map((entry) => entry.path)
      .filter(
        (packagePath) =>
          !packages.some(
            (candidate) =>
              candidate.path !== packagePath &&
              packagePath.startsWith(`${candidate.path}/node_modules/`),
          ),
      );
    return {
      packageLockSha256: sha256(bytes),
      packages,
      topLevelPackagePaths,
    };
  } finally {
    bytes.fill(0);
  }
}

function finalizeRuntimeDependencyInventory(input: {
  readonly packageLockSha256: string;
  readonly packages: readonly RuntimeDependencyPackage[];
  readonly files: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly totalBytes: number;
}): RuntimeDependencyInventory {
  const artifactSha256 = sha256(
    canonicalPostgresBackupJson({
      kind: "pintpath-recovered-application-runtime-dependencies",
      version: 1,
      packageLockSha256: input.packageLockSha256,
      packages: input.packages,
      files: input.files,
    }),
  );
  return { ...input, artifactSha256 };
}

function inspectRuntimeDependencies(input: {
  readonly nodeModulesRoot: string;
  readonly packageLockFile: string;
  readonly destinationRoot?: string;
}): RuntimeDependencyInventory {
  const nodeModulesRoot = exactAbsolute(input.nodeModulesRoot);
  const destinationRoot =
    input.destinationRoot === undefined
      ? undefined
      : exactAbsolute(input.destinationRoot);
  if (
    path.basename(nodeModulesRoot) !== "node_modules" ||
    (destinationRoot !== undefined &&
      (path.basename(destinationRoot) !== "node_modules" ||
        fs.existsSync(destinationRoot)))
  ) {
    fail("runtime_dependency_boundary_unsafe");
  }
  assertTrustedArtifactDirectory(nodeModulesRoot);
  const plan = runtimeDependencyPackages(input.packageLockFile);
  const files: Array<{
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }> = [];
  let totalBytes = 0;
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) {
    fail("runtime_dependency_boundary_unsafe");
  }

  const ensureDestinationDirectory = (directory: string): void => {
    if (destinationRoot === undefined) return;
    const relative = path.relative(destinationRoot, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      fail("runtime_dependency_stage_failed");
    }
    let current = destinationRoot;
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    for (const component of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
      const stat = fs.lstatSync(current, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== BigInt(uid) ||
        (stat.mode & 0o777n) !== 0o700n
      ) {
        fail("runtime_dependency_stage_failed");
      }
    }
  };

  const walk = (
    sourceDirectory: string,
    destinationDirectory?: string,
  ): void => {
    const directoryBefore = fs.lstatSync(sourceDirectory, { bigint: true });
    assertTrustedArtifactDirectory(sourceDirectory);
    if (destinationDirectory !== undefined) {
      ensureDestinationDirectory(destinationDirectory);
    }
    const names = fs
      .readdirSync(sourceDirectory)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const name of names) {
      if (!name || name === "." || name === ".." || name.includes("\0")) {
        fail("runtime_dependency_boundary_unsafe");
      }
      const source = path.join(sourceDirectory, name);
      const destination =
        destinationDirectory === undefined
          ? undefined
          : path.join(destinationDirectory, name);
      const pathStat = fs.lstatSync(source, { bigint: true });
      if (pathStat.isSymbolicLink()) fail("runtime_dependency_boundary_unsafe");
      if (pathStat.isDirectory()) {
        walk(source, destination);
        if (destination !== undefined) fs.chmodSync(destination, 0o500);
        continue;
      }
      if (
        !pathStat.isFile() ||
        pathStat.uid !== BigInt(uid) ||
        pathStat.nlink < 1n ||
        (pathStat.mode & 0o022n) !== 0n ||
        pathStat.size > BigInt(MAX_ARTIFACT_FILE_BYTES) ||
        pathStat.size > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        fail("runtime_dependency_boundary_unsafe");
      }
      let sourceDescriptor: number | null = null;
      let destinationDescriptor: number | null = null;
      let bytes: Buffer | null = null;
      try {
        sourceDescriptor = fs.openSync(
          source,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        const descriptorStat = fs.fstatSync(sourceDescriptor, { bigint: true });
        if (!exactArtifactStat(pathStat, descriptorStat)) {
          fail("runtime_dependency_changed");
        }
        bytes = fs.readFileSync(sourceDescriptor);
        if (BigInt(bytes.length) !== descriptorStat.size) {
          fail("runtime_dependency_changed");
        }
        const afterReadStat = fs.lstatSync(source, { bigint: true });
        if (!exactArtifactObject(descriptorStat, afterReadStat)) {
          fail("runtime_dependency_changed");
        }
        totalBytes += bytes.length;
        if (
          files.length >= MAX_RUNTIME_DEPENDENCY_FILES ||
          totalBytes > MAX_RUNTIME_DEPENDENCY_TOTAL_BYTES
        ) {
          fail("runtime_dependency_boundary_unsafe");
        }
        if (destination !== undefined) {
          destinationDescriptor = fs.openSync(
            destination,
            fs.constants.O_CREAT |
              fs.constants.O_EXCL |
              fs.constants.O_WRONLY |
              fs.constants.O_NOFOLLOW,
            0o400,
          );
          fs.fchmodSync(destinationDescriptor, 0o400);
          fs.writeFileSync(destinationDescriptor, bytes);
          const stagedStat = fs.fstatSync(destinationDescriptor, {
            bigint: true,
          });
          if (
            !stagedStat.isFile() ||
            stagedStat.nlink !== 1n ||
            stagedStat.size !== BigInt(bytes.length) ||
            (stagedStat.mode & 0o777n) !== 0o400n
          ) {
            fail("runtime_dependency_stage_failed");
          }
        }
        files.push({
          path: path
            .relative(nodeModulesRoot, source)
            .split(path.sep)
            .join("/"),
          bytes: bytes.length,
          sha256: sha256(bytes),
        });
      } finally {
        bytes?.fill(0);
        if (destinationDescriptor !== null) fs.closeSync(destinationDescriptor);
        if (sourceDescriptor !== null) fs.closeSync(sourceDescriptor);
      }
    }
    const directoryAfter = fs.lstatSync(sourceDirectory, { bigint: true });
    if (!exactArtifactObject(directoryBefore, directoryAfter)) {
      fail("runtime_dependency_changed");
    }
  };

  if (destinationRoot !== undefined)
    fs.mkdirSync(destinationRoot, { mode: 0o700 });
  for (const packagePath of plan.topLevelPackagePaths) {
    const relativePackagePath = packagePath.slice("node_modules/".length);
    const source = path.join(
      nodeModulesRoot,
      ...relativePackagePath.split("/"),
    );
    const destination =
      destinationRoot === undefined
        ? undefined
        : path.join(destinationRoot, ...relativePackagePath.split("/"));
    if (!fs.existsSync(source)) {
      const planned = plan.packages.find((entry) => entry.path === packagePath);
      if (planned?.optional === true) continue;
      fail("runtime_dependency_install_incomplete");
    }
    walk(source, destination);
    if (destination !== undefined) fs.chmodSync(destination, 0o500);
  }
  if (destinationRoot !== undefined) fs.chmodSync(destinationRoot, 0o500);
  return finalizeRuntimeDependencyInventory({
    packageLockSha256: plan.packageLockSha256,
    packages: plan.packages,
    files,
    totalBytes,
  });
}

export function hashRuntimeDependencyArtifact(
  compiledArtifactRootInput: string,
): string {
  const compiledArtifactRoot = exactAbsolute(compiledArtifactRootInput);
  if (path.basename(compiledArtifactRoot) !== "dist") {
    fail("runtime_dependency_boundary_unsafe");
  }
  const workspaceRoot = path.dirname(compiledArtifactRoot);
  return inspectRuntimeDependencies({
    nodeModulesRoot: path.join(workspaceRoot, "node_modules"),
    packageLockFile: path.join(workspaceRoot, "package-lock.json"),
  }).artifactSha256;
}

function captureStagedArtifactNodes(
  root: string,
): readonly StagedArtifactNode[] {
  const nodes: StagedArtifactNode[] = [];
  const walk = (target: string): void => {
    const stat = fs.lstatSync(target, { bigint: true });
    const relativePath =
      target === root
        ? "."
        : path.relative(root, target).split(path.sep).join("/");
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      fail("compiled_artifact_stage_ambiguous");
    }
    if (stat.isFile()) {
      nodes.push({
        relativePath,
        type: "file",
        stat,
        sha256: hashTrustedArtifactFile(target, 0),
      });
      return;
    }
    nodes.push({ relativePath, type: "directory", stat });
    const names = fs
      .readdirSync(target)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const name of names) {
      if (!name || name === "." || name === ".." || name.includes("\0")) {
        fail("compiled_artifact_stage_ambiguous");
      }
      walk(path.join(target, name));
    }
  };
  walk(root);
  return nodes;
}

function assertStagedArtifactSnapshot(snapshot: StagedArtifactSnapshot): void {
  assertHeldArtifactDirectory(
    snapshot.containerRoot,
    snapshot.containerDescriptor,
    snapshot.containerStat,
  );
  const containerNames = fs.readdirSync(snapshot.containerRoot);
  if (containerNames.length !== 1 || containerNames[0] !== "dist") {
    fail("compiled_artifact_cleanup_ambiguous");
  }
  const observed = captureStagedArtifactNodes(snapshot.destinationRoot);
  if (observed.length !== snapshot.nodes.length)
    fail("compiled_artifact_cleanup_ambiguous");
  for (let index = 0; index < snapshot.nodes.length; index += 1) {
    const expected = snapshot.nodes[index]!;
    const actual = observed[index]!;
    if (
      expected.relativePath !== actual.relativePath ||
      expected.type !== actual.type ||
      expected.sha256 !== actual.sha256 ||
      !exactArtifactStat(expected.stat, actual.stat)
    )
      fail("compiled_artifact_cleanup_ambiguous");
  }
  if (snapshot.runtimeDependencyArtifactSha256) {
    const dependencyFiles = snapshot.nodes
      .filter(
        (node): node is StagedArtifactNode & { readonly sha256: string } =>
          node.type === "file" &&
          node.relativePath.startsWith("node_modules/") &&
          typeof node.sha256 === "string",
      )
      .map((node) => ({
        path: node.relativePath.slice("node_modules/".length),
        bytes: Number(node.stat.size),
        sha256: node.sha256,
      }));
    const dependencyBytes = dependencyFiles.reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    const dependencyInventory = finalizeRuntimeDependencyInventory({
      packageLockSha256: snapshot.runtimeDependencyPackageLockSha256,
      packages: snapshot.runtimeDependencyPackages,
      files: dependencyFiles,
      totalBytes: dependencyBytes,
    });
    if (
      dependencyInventory.artifactSha256 !==
        snapshot.runtimeDependencyArtifactSha256 ||
      dependencyInventory.files.length !==
        snapshot.runtimeDependencyFileCount ||
      dependencyInventory.totalBytes !== snapshot.runtimeDependencyBytes ||
      dependencyInventory.packages.length !==
        snapshot.runtimeDependencyPackageCount
    ) {
      fail("runtime_dependency_stage_ambiguous");
    }
  }
}

function stageCompiledApplicationArtifact(
  sourceInput: string,
  destinationInput: string,
  runtimeDependencies: {
    readonly nodeModulesRoot: string;
    readonly packageLockFile: string;
    readonly expectedArtifactSha256: string;
  },
): StagedArtifactSnapshot {
  const sourceRoot = exactAbsolute(sourceInput);
  const destinationRoot = exactAbsolute(destinationInput);
  const containerRoot = path.dirname(destinationRoot);
  if (
    path.basename(sourceRoot) !== "dist" ||
    path.basename(destinationRoot) !== "dist" ||
    fs.existsSync(path.join(sourceRoot, "node_modules")) ||
    fs.existsSync(destinationRoot)
  )
    fail("compiled_artifact_unsafe");
  assertTrustedArtifactDirectory(sourceRoot);
  const heldContainer = openHeldArtifactDirectory(containerRoot);
  const entries: Array<{
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }> = [];
  let totalBytes = 0;
  const walk = (
    sourceDirectory: string,
    destinationDirectory: string,
  ): void => {
    const directoryBefore = fs.lstatSync(sourceDirectory, { bigint: true });
    assertTrustedArtifactDirectory(sourceDirectory);
    const heldDestination = openHeldArtifactDirectory(destinationDirectory);
    try {
      const names = fs
        .readdirSync(sourceDirectory)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      for (const name of names) {
        assertHeldArtifactDirectory(
          destinationDirectory,
          heldDestination.descriptor,
          heldDestination.stat,
        );
        if (!name || name === "." || name === ".." || name.includes("\0")) {
          fail("compiled_artifact_unsafe");
        }
        const source = path.join(sourceDirectory, name);
        const destination = path.join(destinationDirectory, name);
        const pathStat = fs.lstatSync(source, { bigint: true });
        if (pathStat.isSymbolicLink()) fail("compiled_artifact_unsafe");
        if (pathStat.isDirectory()) {
          fs.mkdirSync(destination, { mode: 0o700 });
          walk(source, destination);
          fs.chmodSync(destination, 0o500);
          continue;
        }
        if (
          !pathStat.isFile() ||
          pathStat.nlink !== 1n ||
          (pathStat.mode & 0o022n) !== 0n
        ) {
          fail("compiled_artifact_unsafe");
        }
        let sourceDescriptor: number | null = null;
        let destinationDescriptor: number | null = null;
        let bytes: Buffer | null = null;
        try {
          sourceDescriptor = fs.openSync(
            source,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
          );
          const descriptorStat = fs.fstatSync(sourceDescriptor, {
            bigint: true,
          });
          if (!exactArtifactStat(pathStat, descriptorStat))
            fail("compiled_artifact_changed");
          if (
            descriptorStat.size > BigInt(MAX_ARTIFACT_FILE_BYTES) ||
            descriptorStat.size > BigInt(Number.MAX_SAFE_INTEGER)
          )
            fail("compiled_artifact_unsafe");
          bytes = fs.readFileSync(sourceDescriptor);
          if (BigInt(bytes.length) !== descriptorStat.size)
            fail("compiled_artifact_changed");
          const afterReadStat = fs.lstatSync(source, { bigint: true });
          if (!exactArtifactStat(descriptorStat, afterReadStat))
            fail("compiled_artifact_changed");
          totalBytes += bytes.length;
          if (
            entries.length >= MAX_ARTIFACT_FILES ||
            totalBytes > MAX_ARTIFACT_TOTAL_BYTES
          ) {
            fail("compiled_artifact_unsafe");
          }
          destinationDescriptor = fs.openSync(
            destination,
            fs.constants.O_CREAT |
              fs.constants.O_EXCL |
              fs.constants.O_WRONLY |
              fs.constants.O_NOFOLLOW,
            0o400,
          );
          fs.fchmodSync(destinationDescriptor, 0o400);
          fs.writeFileSync(destinationDescriptor, bytes);
          fs.fsyncSync(destinationDescriptor);
          const stagedStat = fs.fstatSync(destinationDescriptor, {
            bigint: true,
          });
          if (
            !stagedStat.isFile() ||
            stagedStat.nlink !== 1n ||
            stagedStat.size !== BigInt(bytes.length) ||
            (stagedStat.mode & 0o777n) !== 0o400n
          )
            fail("compiled_artifact_stage_failed");
          entries.push({
            path: path.relative(sourceRoot, source).split(path.sep).join("/"),
            bytes: bytes.length,
            sha256: sha256(bytes),
          });
        } finally {
          bytes?.fill(0);
          if (destinationDescriptor !== null)
            fs.closeSync(destinationDescriptor);
          if (sourceDescriptor !== null) fs.closeSync(sourceDescriptor);
        }
      }
      assertHeldArtifactDirectory(
        destinationDirectory,
        heldDestination.descriptor,
        heldDestination.stat,
      );
    } finally {
      fs.closeSync(heldDestination.descriptor);
    }
    const directoryAfter = fs.lstatSync(sourceDirectory, { bigint: true });
    if (!exactArtifactStat(directoryBefore, directoryAfter))
      fail("compiled_artifact_changed");
  };
  try {
    assertHeldArtifactDirectory(
      containerRoot,
      heldContainer.descriptor,
      heldContainer.stat,
    );
    fs.mkdirSync(destinationRoot, { mode: 0o700 });
    walk(sourceRoot, destinationRoot);
    const runtimeDependencyInventory = inspectRuntimeDependencies({
      nodeModulesRoot: runtimeDependencies.nodeModulesRoot,
      packageLockFile: runtimeDependencies.packageLockFile,
      destinationRoot: path.join(destinationRoot, "node_modules"),
    });
    if (
      runtimeDependencyInventory.artifactSha256 !==
      runtimeDependencies.expectedArtifactSha256
    ) {
      fail("runtime_dependency_artifact_mismatch");
    }
    fs.chmodSync(destinationRoot, 0o500);
    assertHeldArtifactDirectory(
      containerRoot,
      heldContainer.descriptor,
      heldContainer.stat,
    );
    const observed = new Set(entries.map((entry) => entry.path));
    if (REQUIRED_ARTIFACT_FILES.some((required) => !observed.has(required))) {
      fail("compiled_artifact_incomplete");
    }
    const artifactSha256 = sha256(
      canonicalPostgresBackupJson({
        kind: "pintpath-compiled-application-artifact",
        version: 1,
        files: entries,
      }),
    );
    const snapshot: StagedArtifactSnapshot = {
      containerRoot,
      destinationRoot,
      containerDescriptor: heldContainer.descriptor,
      containerStat: heldContainer.stat,
      nodes: captureStagedArtifactNodes(destinationRoot),
      artifactSha256,
      runtimeDependencyArtifactSha256:
        runtimeDependencyInventory.artifactSha256,
      runtimeDependencyPackageLockSha256:
        runtimeDependencyInventory.packageLockSha256,
      runtimeDependencyPackages: runtimeDependencyInventory.packages,
      runtimeDependencyPackageCount: runtimeDependencyInventory.packages.length,
      runtimeDependencyFileCount: runtimeDependencyInventory.files.length,
      runtimeDependencyBytes: runtimeDependencyInventory.totalBytes,
    };
    assertStagedArtifactSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    let cleanupFailed = false;
    if (fs.existsSync(destinationRoot)) {
      try {
        const partialSnapshot: StagedArtifactSnapshot = {
          containerRoot,
          destinationRoot,
          containerDescriptor: heldContainer.descriptor,
          containerStat: heldContainer.stat,
          nodes: captureStagedArtifactNodes(destinationRoot),
          artifactSha256: "",
          runtimeDependencyArtifactSha256: "",
          runtimeDependencyPackageLockSha256: "",
          runtimeDependencyPackages: [],
          runtimeDependencyPackageCount: 0,
          runtimeDependencyFileCount: 0,
          runtimeDependencyBytes: 0,
        };
        removeStagedArtifactTreeExactly(partialSnapshot);
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      fs.closeSync(heldContainer.descriptor);
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) fail("compiled_artifact_cleanup_failed");
    throw error;
  }
}

function removeStagedArtifactTreeExactly(
  snapshot: StagedArtifactSnapshot,
): void {
  assertStagedArtifactSnapshot(snapshot);
  for (const node of snapshot.nodes.filter(
    (entry) => entry.type === "directory",
  )) {
    const target =
      node.relativePath === "."
        ? snapshot.destinationRoot
        : path.join(snapshot.destinationRoot, ...node.relativePath.split("/"));
    const stat = fs.lstatSync(target, { bigint: true });
    if (!exactArtifactIdentity(node.stat, stat))
      fail("compiled_artifact_cleanup_ambiguous");
    fs.chmodSync(target, 0o700);
  }
  const descendants = snapshot.nodes
    .filter((node) => node.relativePath !== ".")
    .sort((left, right) => {
      const depth = (value: string) => value.split("/").length;
      const depthDifference =
        depth(right.relativePath) - depth(left.relativePath);
      if (depthDifference !== 0) return depthDifference;
      if (left.type !== right.type) return left.type === "file" ? -1 : 1;
      return left.relativePath < right.relativePath ? -1 : 1;
    });
  for (const node of descendants) {
    const target = path.join(
      snapshot.destinationRoot,
      ...node.relativePath.split("/"),
    );
    const stat = fs.lstatSync(target, { bigint: true });
    if (
      node.type === "file"
        ? !exactArtifactStat(node.stat, stat)
        : !exactArtifactObject(node.stat, stat)
    )
      fail("compiled_artifact_cleanup_ambiguous");
    if (node.type === "file") {
      if (hashTrustedArtifactFile(target) !== node.sha256) {
        fail("compiled_artifact_cleanup_ambiguous");
      }
      fs.unlinkSync(target);
    } else {
      fs.rmdirSync(target);
    }
  }
  const rootNode = snapshot.nodes.find((node) => node.relativePath === ".");
  if (!rootNode) fail("compiled_artifact_cleanup_ambiguous");
  const rootStat = fs.lstatSync(snapshot.destinationRoot, { bigint: true });
  if (!exactArtifactObject(rootNode.stat, rootStat)) {
    fail("compiled_artifact_cleanup_ambiguous");
  }
  fs.rmdirSync(snapshot.destinationRoot);
  assertHeldArtifactDirectory(
    snapshot.containerRoot,
    snapshot.containerDescriptor,
    snapshot.containerStat,
  );
  if (fs.readdirSync(snapshot.containerRoot).length !== 0) {
    fail("compiled_artifact_cleanup_ambiguous");
  }
}

function removeStagedArtifactExactly(
  snapshot: StagedArtifactSnapshot,
  removeContainer: (directory: string) => void,
): void {
  let ambiguity = false;
  try {
    removeStagedArtifactTreeExactly(snapshot);
  } catch {
    ambiguity = true;
  }
  if (ambiguity) {
    fs.closeSync(snapshot.containerDescriptor);
    fail("compiled_artifact_cleanup_ambiguous");
  }
  try {
    if (fs.readdirSync(snapshot.containerRoot).length !== 0) {
      fail("compiled_artifact_cleanup_ambiguous");
    }
    removeContainer(snapshot.containerRoot);
  } finally {
    fs.closeSync(snapshot.containerDescriptor);
  }
}

function hashTrustedArtifactFile(filename: string, minBytes = 1): string {
  const bytes = readTrustedRegularFile(filename, {
    minBytes,
    maxBytes: MAX_ARTIFACT_FILE_BYTES,
    requireOwner: true,
  });
  try {
    return sha256(bytes);
  } finally {
    bytes.fill(0);
  }
}

function decodeJwtPart(value: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{2,8192}$/.test(value)) fail("auth_token_invalid");
  let decoded: unknown;
  try {
    const text = Buffer.from(value, "base64url").toString("utf8");
    decoded = JSON.parse(text) as unknown;
  } catch {
    fail("auth_token_invalid");
  }
  if (!isRecord(decoded)) fail("auth_token_invalid");
  return decoded;
}

export function assertDisposableSupabaseAccessTokenIdentity(
  token: string,
  expectedSupabaseOrigin: string,
  now = new Date(),
): ParsedAccessToken {
  if (!SUPABASE_ORIGIN.test(expectedSupabaseOrigin))
    fail("auth_target_invalid");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part))
    fail("auth_token_invalid");
  const header = decodeJwtPart(parts[0]!);
  const payload = decodeJwtPart(parts[1]!);
  const issuer = `${expectedSupabaseOrigin}/auth/v1`;
  const audience = payload.aud;
  const audienceExact =
    audience === "authenticated" ||
    (Array.isArray(audience) &&
      audience.length === 1 &&
      audience[0] === "authenticated");
  const subject = payload.sub;
  const sessionId = payload.session_id;
  const issuedAtSeconds = payload.iat;
  const expiresAtSeconds = payload.exp;
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (
    !["RS256", "ES256", "EdDSA", "HS256"].includes(String(header.alg)) ||
    payload.iss !== issuer ||
    payload.role !== "authenticated" ||
    !audienceExact ||
    typeof subject !== "string" ||
    !UUID.test(subject) ||
    typeof sessionId !== "string" ||
    !UUID.test(sessionId) ||
    !Number.isSafeInteger(issuedAtSeconds) ||
    !Number.isSafeInteger(expiresAtSeconds) ||
    Number(issuedAtSeconds) > nowSeconds + 60 ||
    Number(expiresAtSeconds) <= nowSeconds ||
    Number(expiresAtSeconds) - Number(issuedAtSeconds) > 86_400
  )
    fail("auth_token_identity_mismatch");
  return {
    subject,
    sessionId,
    issuedAtSeconds: Number(issuedAtSeconds),
    expiresAtSeconds: Number(expiresAtSeconds),
  };
}

export function proveCrossProjectTokenRejectedLocally(
  expectedSupabaseOrigin: string,
  now = new Date(),
): true {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const token = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: "https://crossprojectref0000.supabase.co/auth/v1",
    sub: "10000000-0000-4000-8000-000000000001",
    session_id: "20000000-0000-4000-8000-000000000002",
    aud: "authenticated",
    role: "authenticated",
    iat: nowSeconds,
    exp: nowSeconds + 3_600,
  })}.signature`;
  try {
    assertDisposableSupabaseAccessTokenIdentity(
      token,
      expectedSupabaseOrigin,
      now,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.endsWith("auth_token_identity_mismatch")
    )
      return true;
    throw error;
  }
  fail("cross_project_token_accepted");
}

function readBoundedResponse(response: BoundedHttpResponse): unknown {
  try {
    return JSON.parse(response.body.toString("utf8")) as unknown;
  } catch {
    fail("response_invalid");
  } finally {
    response.body.fill(0);
  }
}

function discardBoundedResponse(response: BoundedHttpResponse): void {
  response.body.fill(0);
}

async function fetchBoundedly(
  fetchFunction: typeof globalThis.fetch,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<BoundedHttpResponse> {
  const controller = new AbortController();
  let response: Response | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const chunks: Buffer[] = [];
  const operation = (async (): Promise<BoundedHttpResponse> => {
    response = await fetchFunction(input, {
      ...init,
      signal: controller.signal,
    });
    const setCookieHeaders = readSetCookieHeaders(response.headers);
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_HTTP_RESPONSE_BYTES
    ) {
      fail("response_too_large");
    }
    reader = response.body?.getReader() ?? null;
    if (!reader) {
      return { status: response.status, body: Buffer.alloc(0), setCookieHeaders };
    }
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (timedOut) throw new Error("bounded_http_timeout");
        if (result.done) break;
        const chunk = Buffer.from(result.value);
        total += chunk.length;
        if (total > MAX_HTTP_RESPONSE_BYTES) {
          chunk.fill(0);
          void reader.cancel("response_too_large").catch(() => undefined);
          fail("response_too_large");
        }
        chunks.push(chunk);
      }
      if (timedOut) throw new Error("bounded_http_timeout");
      const body = Buffer.concat(chunks, total);
      return { status: response.status, body, setCookieHeaders };
    } finally {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      reader.releaseLock();
    }
  })();
  void operation.catch(() => undefined);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (reader) {
        void reader.cancel("request_timeout").catch(() => undefined);
      } else if (response?.body && !response.body.locked) {
        void response.body.cancel("request_timeout").catch(() => undefined);
      }
      reject(new Error("bounded_http_timeout"));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    }
  }
}

export function assertRecoveryProbePayload(
  payload: unknown,
  route: "startup" | "ready",
  candidateSha: string,
): void {
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.data)) {
    fail(`${route}_probe_invalid`);
  }
  const data = payload.data;
  const rehearsal = data.postgresRecoveryRehearsal;
  const deployment = data.deployment;
  const dependencies = data.dependencies;
  if (
    data.service !== "pint-path" ||
    data.status !== (route === "startup" ? "startup_ready" : "ready") ||
    !isRecord(deployment) ||
    deployment.commitSha !== candidateSha ||
    deployment.environment !== "production" ||
    !isRecord(rehearsal) ||
    rehearsal.enabled !== true ||
    rehearsal.candidateSha !== candidateSha ||
    rehearsal.loopbackOnly !== true ||
    rehearsal.postgresRuntime !== true ||
    rehearsal.automaticMaintenanceEnabled !== false ||
    rehearsal.externalWritesAllowed !== false ||
    rehearsal.providerSchedulersEnabled !== false ||
    !isRecord(dependencies) ||
    !isRecord(dependencies.database) ||
    dependencies.database.status !== "ok"
  )
    fail(`${route}_probe_invalid`);
  if (route === "startup") {
    if (
      !isRecord(dependencies.accountDeletionNotifications) ||
      dependencies.accountDeletionNotifications.required !== false
    )
      fail("startup_probe_invalid");
    return;
  }
  if (
    !isRecord(dependencies.supabaseAuth) ||
    dependencies.supabaseAuth.status !== "ok" ||
    dependencies.supabaseAuth.liveProbe !== true ||
    !isRecord(dependencies.supabaseDatabase) ||
    dependencies.supabaseDatabase.status !==
      "disabled_for_postgres_recovery_rehearsal" ||
    !isRecord(dependencies.supabaseEvidenceStorage) ||
    dependencies.supabaseEvidenceStorage.status !==
      "disabled_for_postgres_recovery_rehearsal" ||
    !isRecord(dependencies.billingProvider) ||
    dependencies.billingProvider.status !== "disabled_for_restore_rehearsal" ||
    !isRecord(dependencies.venueLookupProvider) ||
    dependencies.venueLookupProvider.status !==
      "disabled_for_restore_rehearsal" ||
    !isRecord(dependencies.menuExtractionProvider) ||
    dependencies.menuExtractionProvider.status !==
      "disabled_for_restore_rehearsal" ||
    !isRecord(dependencies.reportDelivery) ||
    dependencies.reportDelivery.status !== "disabled" ||
    dependencies.reportDelivery.scheduled !== false ||
    !isRecord(dependencies.accountDeletionNotifications) ||
    dependencies.accountDeletionNotifications.status !==
      "disabled_for_restore_rehearsal" ||
    !isRecord(dependencies.postgresRecoveryRehearsal) ||
    dependencies.postgresRecoveryRehearsal.externalWritesAllowed !== false ||
    dependencies.postgresRecoveryRehearsal.automaticMaintenanceEnabled !==
      false ||
    dependencies.postgresRecoveryRehearsal.providerSchedulersEnabled !==
      false ||
    !isRecord(dependencies.rateLimiterRedis) ||
    dependencies.rateLimiterRedis.status !== "ok" ||
    dependencies.rateLimiterRedis.ready !== true ||
    !isRecord(dependencies.rateLimiterRedis.identity) ||
    dependencies.rateLimiterRedis.identity.verified !== true ||
    !isRecord(dependencies.offsiteBackup) ||
    dependencies.offsiteBackup.status !== "ok" ||
    dependencies.offsiteBackup.required !== false ||
    dependencies.offsiteBackup.liveProbe !== false
  )
    fail("ready_probe_invalid");
}

export async function waitForRecoveryProbe(input: {
  readonly fetch: typeof globalThis.fetch;
  readonly url: string;
  readonly route: "startup" | "ready";
  readonly candidateSha: string;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly childExited: () => boolean;
  readonly outputExceeded: () => boolean;
}): Promise<void> {
  const deadline = input.now().getTime() + input.startupTimeoutMs;
  while (input.now().getTime() < deadline) {
    if (input.childExited()) fail(`${input.route}_child_exited`);
    if (input.outputExceeded()) fail("child_output_limit_exceeded");
    try {
      const response = await fetchBoundedly(
        input.fetch,
        input.url,
        { method: "GET", redirect: "error", cache: "no-store" },
        input.requestTimeoutMs,
      );
      if (response.status === 200) {
        assertRecoveryProbePayload(
          readBoundedResponse(response),
          input.route,
          input.candidateSha,
        );
        return;
      }
      discardBoundedResponse(response);
      if (response.status !== 503) fail(`${input.route}_non_2xx`);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("recovered_postgres_application_")
      )
        throw error;
    }
    await input.sleep(
      Math.min(200, Math.max(1, deadline - input.now().getTime())),
    );
  }
  fail(`${input.route}_timeout`);
}

function forbiddenPrivateKey(key: string): boolean {
  return /^(?:passwordHash|supabaseUserId|providerTokensValidAfter|stripeCustomerId|stripePaidSubscriptionStatus|tokenHash|providerSessionIdHash|lastIpHash|userAgentHash|reviewClaimToken|rawBody|sourcePhotoUrl)$/i.test(
    key,
  );
}

function containsForbiddenPrivateKey(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value))
    return value.some((entry) => containsForbiddenPrivateKey(entry, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      forbiddenPrivateKey(key) || containsForbiddenPrivateKey(entry, depth + 1),
  );
}

export function assertAuthenticatedAccountBoundary(input: {
  readonly payload: unknown;
  readonly expectedSubject: string;
  readonly expectedEmail: string;
  readonly forbiddenValues: readonly string[];
}): void {
  if (
    !isRecord(input.payload) ||
    input.payload.ok !== true ||
    !isRecord(input.payload.data)
  ) {
    fail("authenticated_boundary_invalid");
  }
  const dashboard = input.payload.data;
  const account = dashboard.account;
  const access = dashboard.access;
  if (
    !isRecord(account) ||
    account.id !== input.expectedSubject ||
    account.email !== input.expectedEmail ||
    account.role !== "user" ||
    account.subscriptionStatus !== "free" ||
    account.status !== "active" ||
    account.authProvider !== "supabase" ||
    account.legalAcceptanceCurrent !== true ||
    !isRecord(access) ||
    access.isAuthenticated !== true ||
    access.accountRole !== "user" ||
    access.isAdminAccount !== false ||
    access.isAdmin !== false ||
    access.status !== "free" ||
    dashboard.billing !== null ||
    !Array.isArray(dashboard.counterStaffAssignments) ||
    dashboard.counterStaffAssignments.length !== 0 ||
    !Array.isArray(dashboard.counterStaffInvitations) ||
    dashboard.counterStaffInvitations.length !== 0 ||
    containsForbiddenPrivateKey(dashboard)
  )
    fail("authenticated_boundary_invalid");
  const serialized = canonicalPostgresBackupJson(input.payload);
  if (
    input.forbiddenValues.some(
      (value) => value.length > 0 && serialized.includes(value),
    )
  )
    fail("private_data_leakage");
}

function attachBoundedRedactedOutput(input: {
  readonly child: ManagedRecoveryChild;
  readonly limitBytes: number;
  readonly knownSecrets: readonly string[];
}): { readonly exceeded: () => boolean } {
  let observedBytes = 0;
  let exceeded = false;
  const consume = (chunk: unknown): void => {
    const raw = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), "utf8");
    observedBytes += raw.length;
    // Redaction is performed before the bounded sample is discarded. No child
    // output is ever copied into stdout, stderr, an exception, or the receipt.
    void redactKnownSecretValues(
      raw
        .subarray(
          0,
          Math.max(
            0,
            input.limitBytes - Math.min(observedBytes, input.limitBytes),
          ),
        )
        .toString("utf8"),
      input.knownSecrets,
    );
    if (observedBytes > input.limitBytes && !exceeded) {
      exceeded = true;
      input.child.kill("SIGKILL");
    }
  };
  input.child.stdout?.on("data", consume);
  input.child.stderr?.on("data", consume);
  return { exceeded: () => exceeded };
}

function waitForChildExit(
  child: ManagedRecoveryChild,
  timeoutMs: number,
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
} | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      value: {
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      } | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(value);
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      finish({ code, signal });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({ code: child.exitCode, signal: child.signalCode });
    }
  });
}

async function terminateChild(
  child: ManagedRecoveryChild,
  timeoutMs: number,
  requireGraceful: boolean,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (requireGraceful) fail("child_terminated_unexpectedly");
    return true;
  }
  let sent = false;
  try {
    sent = child.kill("SIGTERM");
  } catch {
    sent = false;
  }
  if (!sent && child.exitCode === null && child.signalCode === null) {
    fail("child_termination_failed");
  }
  const exit = await waitForChildExit(child, timeoutMs);
  if (!exit) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The second bounded wait below is authoritative.
    }
    await waitForChildExit(child, Math.min(2_000, timeoutMs));
    fail("child_termination_timeout");
  }
  if (requireGraceful && (exit.code !== 0 || exit.signal !== null)) {
    fail("child_termination_inexact");
  }
  return true;
}

export async function terminateRecoveredApplicationChild(
  child: ManagedRecoveryChild,
  timeoutMs: number,
): Promise<true> {
  await terminateChild(child, timeoutMs, true);
  return true;
}

async function boundedOperation(
  operation: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("bounded_operation_timeout")),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function closeRecoveryAuthoritiesBoundedly(input: {
  readonly pools: readonly PoolBoundary[];
  readonly transport: Pick<
    PostgresRailwayStockLocalhostCaTransport,
    "close"
  > | null;
  readonly timeoutMs: number;
}): Promise<true> {
  const failures: unknown[] = [];
  const poolResults = await Promise.allSettled(
    input.pools.map((pool) =>
      boundedOperation(() => pool.end(), input.timeoutMs),
    ),
  );
  failures.push(
    ...poolResults.filter((result) => result.status === "rejected"),
  );
  if (input.transport) {
    try {
      await boundedOperation(() => input.transport!.close(), input.timeoutMs);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) fail("authority_close_failed");
  return true;
}

function childEnvironment(input: {
  readonly args: CeremonyArguments;
  readonly runtimeUrl: string;
  readonly maintenanceUrl: string;
  readonly redisUrl: string;
  readonly rootCaPem: string;
  readonly supabasePublishableKey: string;
  readonly redisSentinel: string;
  readonly sourceEvidenceSigningSecret: string;
}): NodeJS.ProcessEnv {
  const { args } = input;
  const targetOrigin = `http://127.0.0.1:${args.appPort}`;
  return {
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(args.appPort),
    PUBLIC_BASE_URL: targetOrigin,
    TRUST_PROXY_HOPS: "0",
    POSTGRES_RECOVERY_REHEARSAL_MODE: "true",
    POSTGRES_RECOVERY_CANDIDATE_SHA: args.candidateSha,
    POSTGRES_RECOVERY_EXPECTED_RAILWAY_PROJECT_ID: args.railwayProjectId,
    POSTGRES_RECOVERY_EXPECTED_RAILWAY_ENVIRONMENT_ID:
      args.railwayEnvironmentId,
    POSTGRES_RECOVERY_EXPECTED_RAILWAY_SERVICE_ID: args.railwayServiceId,
    POSTGRES_RECOVERY_PRODUCTION_RAILWAY_PROJECT_ID:
      args.productionRailwayProjectId,
    POSTGRES_RECOVERY_PRODUCTION_RAILWAY_ENVIRONMENT_ID:
      args.productionRailwayEnvironmentId,
    POSTGRES_RECOVERY_PRODUCTION_RAILWAY_SERVICE_ID:
      args.productionRailwayServiceId,
    POSTGRES_RECOVERY_EXPECTED_SUPABASE_URL: args.supabaseUrl,
    POSTGRES_RECOVERY_EXPECTED_SUPABASE_PUBLISHABLE_KEY_SHA256:
      args.expectedSupabasePublishableKeySha256,
    POSTGRES_RECOVERY_PRODUCTION_SUPABASE_PUBLISHABLE_KEY_SHA256:
      args.productionSupabasePublishableKeySha256,
    POSTGRES_RECOVERY_PERMANENT_STAGING_SUPABASE_PUBLISHABLE_KEY_SHA256:
      args.permanentStagingSupabasePublishableKeySha256,
    POSTGRES_RECOVERY_EXPECTED_MAINTENANCE_URL_SHA256:
      args.expectedMaintenanceUrlSha256,
    POSTGRES_RECOVERY_REDIS_SENTINEL: input.redisSentinel,
    POSTGRES_RECOVERY_PRODUCTION_DATABASE_RESOURCE_ID:
      args.productionDatabaseResourceId,
    POSTGRES_RECOVERY_PRODUCTION_DATABASE_URL_SHA256:
      args.productionDatabaseUrlSha256,
    POSTGRES_RECOVERY_PRODUCTION_REDIS_RESOURCE_ID:
      args.productionRedisResourceId,
    POSTGRES_RECOVERY_PRODUCTION_REDIS_URL_SHA256:
      args.productionRedisUrlSha256,
    RAILWAY_GIT_COMMIT_SHA: args.candidateSha,
    RAILWAY_PROJECT_ID: args.railwayProjectId,
    RAILWAY_ENVIRONMENT_ID: args.railwayEnvironmentId,
    RAILWAY_SERVICE_ID: args.railwayServiceId,
    PINTPATH_IDENTITY_REGISTRY_PHASE: "complete",
    PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID:
      args.permanentStagingRailwayProjectId,
    PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID:
      args.permanentStagingRailwayEnvironmentId,
    PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID:
      args.permanentStagingRailwayServiceId,
    DATABASE_URL: input.runtimeUrl,
    // security-scan allow: value came from a held mode-0600 descriptor and is child-env-only
    DATABASE_MAINTENANCE_URL: input.maintenanceUrl, // security-scan allow: descriptor-backed child env
    PINTPATH_POSTGRES_ROOT_CA_PEM: input.rootCaPem,
    PINTPATH_POSTGRES_ROOT_CA_DER_SHA256: args.expectedRootCaDerSha256,
    PINTPATH_DATABASE_RESOURCE_ID: args.databaseResourceId,
    PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: args.databaseResourceId,
    PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: `${args.productionDatabaseResourceId},${args.permanentStagingDatabaseResourceId}`,
    PINTPATH_EXPECTED_DATABASE_URL_SHA256: args.expectedRuntimeUrlSha256,
    PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${args.productionDatabaseUrlSha256},${args.permanentStagingDatabaseUrlSha256}`,
    PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID:
      args.permanentStagingDatabaseResourceId,
    PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256:
      args.permanentStagingDatabaseUrlSha256,
    REDIS_URL: input.redisUrl,
    PINTPATH_REDIS_RESOURCE_ID: args.redisResourceId,
    PINTPATH_EXPECTED_REDIS_RESOURCE_ID: args.redisResourceId,
    PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: `${args.productionRedisResourceId},${args.permanentStagingRedisResourceId}`,
    PINTPATH_EXPECTED_REDIS_URL_SHA256: args.expectedRedisUrlSha256,
    PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: `${args.productionRedisUrlSha256},${args.permanentStagingRedisUrlSha256}`,
    PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID:
      args.permanentStagingRedisResourceId,
    PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256:
      args.permanentStagingRedisUrlSha256,
    REDIS_KEY_NAMESPACE: `pint-path:postgres-recovery:${args.railwayEnvironmentId}:${args.candidateSha}`,
    REQUIRE_REDIS_RATE_LIMITING: "true",
    ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: "false",
    SUPABASE_URL: args.supabaseUrl,
    SUPABASE_ANON_KEY: input.supabasePublishableKey,
    SUPABASE_OAUTH_PROVIDERS: "",
    SOURCE_EVIDENCE_SIGNING_SECRET: input.sourceEvidenceSigningSecret,
    REPORT_EMAIL_MODE: "disabled",
    REPORT_DELIVERY_SCHEDULE_ENABLED: "false",
    ACCOUNT_DELETION_NOTICE_MODE: "disabled",
    DEMO_BILLING_MODE: "false",
    ALLOW_DEMO_BILLING_IN_PRODUCTION: "false",
    ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: "false",
    COMMERCIAL_LAUNCH_ENABLED: "false",
    CONSUMER_PAID_ENROLLMENT_ENABLED: "false",
    PINT_POINTS_REWARDS_ENABLED: "false",
    ALCOHOL_GAMIFICATION_ENABLED: "false",
    FIELD_TEST_MODE: "false",
    VENUE_PRO_TRIAL_DAYS: "0",
    VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD: "false",
    REQUIRE_ADMIN_MFA_IN_PRODUCTION: "true",
    REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: "true",
    OPENAI_MENU_OCR_COST_BOUND_MODE: "false",
    NODE_NO_WARNINGS: "1",
    NO_COLOR: "1",
  };
}

function poolConfig(
  connectionString: string,
  transport: PostgresRailwayStockLocalhostCaTransport,
  role: "pintpath_runtime" | "pintpath_maintenance",
  applicationName: string,
): PoolConfig {
  return {
    connectionString,
    host: transport.nodeConnection.host,
    port: transport.nodeConnection.port,
    ssl: transport.nodeConnection.ssl,
    max: 1,
    application_name: applicationName,
    options: `-crole=${role} -csearch_path=pintpath_app,public`,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  };
}

async function verifyDatabaseSmoke(
  pool: PoolBoundary,
  tombstones: number,
): Promise<void> {
  const result =
    await pool.query<SmokeRow>(`/* pintpath:recovered-application:smoke */
    WITH replayed AS (
      SELECT request.id, request.user_id
      FROM pintpath_app.account_deletion_requests request
      WHERE request.deletion_tombstone_recorded_at IS NOT NULL
    )
    SELECT
      current_user AS "effectiveRole",
      current_setting('pintpath.logical_restore_target_class', true) AS "targetClass",
      (SELECT value FROM pintpath_app.schema_metadata WHERE key = 'schema_version') AS "schemaVersion",
      (SELECT value FROM pintpath_app.schema_metadata WHERE key = 'import_state') AS "migrationState",
      (SELECT count(*)::text FROM information_schema.tables
        WHERE table_schema = 'pintpath_app' AND table_type = 'BASE TABLE') AS "authoritativeTables",
      has_schema_privilege('pintpath_runtime', 'pintpath_ops', 'USAGE') AS "runtimeOperationsUsage",
      has_schema_privilege('pintpath_maintenance', 'pintpath_app', 'USAGE') AS "maintenanceApplicationUsage",
      has_schema_privilege('pintpath_maintenance', 'pintpath_ops', 'USAGE') AS "maintenanceOperationsUsage",
      EXISTS (
        SELECT 1 FROM pg_auth_members membership
        JOIN pg_roles member ON member.oid = membership.member
        JOIN pg_roles granted ON granted.oid = membership.roleid
        WHERE member.rolname = 'pintpath_maintenance'
          AND granted.rolname NOT IN ('pintpath_runtime')
      ) AS "maintenanceUnexpectedMembership",
      (SELECT count(*)::text FROM replayed) AS "replayedRequestCount",
      (SELECT count(*)::text FROM pintpath_app.account_deletion_requests request
        JOIN replayed ON replayed.id = request.id
        WHERE request.status = 'completed') AS "replayedCompletedCount",
      (SELECT count(*)::text FROM pintpath_app.account_deletion_completion_outbox notice
        JOIN replayed ON replayed.id = notice.request_id
        WHERE notice.status = 'suppressed_restore') AS "replayedSuppressedCount",
      (SELECT count(*)::text FROM pintpath_app.account_deletion_notice_recipient_secrets secret
        JOIN replayed ON replayed.id = secret.request_id) AS "replayedRecipientSecretCount",
      (SELECT count(*)::text FROM pintpath_app.auth_sessions session
        JOIN replayed ON replayed.user_id = session.user_id) AS "replayedAuthSessionCount",
      (SELECT count(*)::text FROM pintpath_app.source_evidence_objects evidence
        JOIN replayed ON replayed.user_id = evidence.owner_user_id
        WHERE evidence.deleted_at IS NULL) AS "replayedActiveEvidenceCount"
  `);
  const row = result.rows[0];
  if (
    !row ||
    row.effectiveRole !== "pintpath_runtime" ||
    row.targetClass !== "disposable-rehearsal" ||
    row.schemaVersion !== "1" ||
    row.migrationState !== "ready" ||
    row.authoritativeTables !== "56" ||
    row.runtimeOperationsUsage ||
    !row.maintenanceApplicationUsage ||
    row.maintenanceOperationsUsage ||
    row.maintenanceUnexpectedMembership ||
    row.replayedRequestCount !== String(tombstones) ||
    row.replayedCompletedCount !== String(tombstones) ||
    row.replayedSuppressedCount !== String(tombstones) ||
    row.replayedRecipientSecretCount !== "0" ||
    row.replayedAuthSessionCount !== "0" ||
    row.replayedActiveEvidenceCount !== "0"
  )
    fail("database_smoke_failed");
}

async function verifyMaintenanceBoundary(pool: PoolBoundary): Promise<void> {
  const result =
    await pool.query<MaintenanceRow>(`/* pintpath:recovered-application:maintenance */
    SELECT
      current_user AS "effectiveRole",
      has_schema_privilege(current_user, 'pintpath_app', 'USAGE') AS "applicationUsage",
      has_schema_privilege(current_user, 'pintpath_ops', 'USAGE') AS "operationsUsage",
      COALESCE(pg_has_role(session_user, to_regrole('pintpath_runtime'), 'MEMBER'), false)
        AS "runtimeMembership",
      EXISTS (
        SELECT 1 FROM pg_auth_members membership
        JOIN pg_roles member ON member.oid = membership.member
        JOIN pg_roles granted ON granted.oid = membership.roleid
        WHERE member.rolname = session_user
          AND granted.rolname NOT IN ('pintpath_maintenance', 'pintpath_runtime')
      ) AS "unexpectedMembership"
  `);
  const row = result.rows[0];
  if (
    !row ||
    row.effectiveRole !== "pintpath_maintenance" ||
    !row.applicationUsage ||
    row.operationsUsage ||
    row.runtimeMembership ||
    row.unexpectedMembership
  )
    fail("maintenance_boundary_failed");
}

async function restoredAccount(
  pool: PoolBoundary,
  subject: string,
  email: string,
): Promise<RestoredAccountRow> {
  const result = await pool.query<RestoredAccountRow>(
    `/* pintpath:recovered-application:auth-account */
    SELECT
      account.id,
      account.supabase_user_id AS "supabaseUserId",
      lower(account.email) AS "email",
      account.role,
      account.subscription_status AS "subscriptionStatus",
      account.status,
      account.auth_provider AS "authProvider",
      (
        account.terms_accepted_at IS NOT NULL
        AND account.privacy_accepted_at IS NOT NULL
        AND account.terms_version = '2026-08-03'
        AND account.privacy_version = '2026-08-03'
      ) AS "legalAcceptanceCurrent",
      EXISTS (
        SELECT 1 FROM pintpath_app.account_privacy_settings privacy
        WHERE privacy.user_id = account.id
      ) AS "privacySettingsPresent",
      (
        SELECT count(*)::text FROM pintpath_app.venue_manager_assignments assignment
        WHERE assignment.user_id = account.id AND assignment.status IN ('active', 'pending')
      ) AS "activeVenueAssignmentCount"
    FROM pintpath_app.accounts account
    WHERE account.id = $1 AND account.supabase_user_id = $1 AND lower(account.email) = $2
  `,
    [subject, email],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    row.id !== subject ||
    row.supabaseUserId !== subject ||
    row.email !== email ||
    row.role !== "user" ||
    row.subscriptionStatus !== "free" ||
    row.status !== "active" ||
    row.authProvider !== "supabase" ||
    !row.legalAcceptanceCurrent ||
    !row.privacySettingsPresent ||
    row.activeVenueAssignmentCount !== "0"
  )
    fail("restored_auth_account_invalid");
  return row;
}

async function assertNoOtherAccountEmailLeakage(
  pool: PoolBoundary,
  subject: string,
  payload: unknown,
): Promise<void> {
  const serialized = canonicalPostgresBackupJson(payload);
  const result = await pool.query<LeakageRow>(
    `/* pintpath:recovered-application:email-leakage */
    SELECT EXISTS (
      SELECT 1 FROM pintpath_app.accounts other
      WHERE other.id <> $1
        AND length(other.email) > 0
        AND position(lower(other.email) in lower($2)) > 0
    ) AS "otherAccountEmailPresent"
  `,
    [subject, serialized],
  );
  if (result.rows[0]?.otherAccountEmailPresent !== false) {
    fail("private_data_leakage");
  }
}

async function assertSessionRevoked(
  pool: PoolBoundary,
  appToken: string,
  subject: string,
  providerSessionId: string,
): Promise<void> {
  const tokenHash = sha256(appToken);
  const providerSessionIdHash = sha256(`supabase-session:${providerSessionId}`);
  const result = await pool.query<SessionCleanupRow>(
    `/* pintpath:recovered-application:session-cleanup */
    SELECT
      session.user_id AS "userId",
      session.provider_session_id_hash AS "providerSessionIdHash",
      session.revoked_at IS NOT NULL AS "revoked"
    FROM pintpath_app.auth_sessions session
    WHERE session.token_hash = $1
  `,
    [tokenHash],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    row.userId !== subject ||
    row.providerSessionIdHash !== providerSessionIdHash ||
    !row.revoked
  )
    fail("app_session_cleanup_failed");
}

async function exactJsonRequest(input: {
  readonly fetch: typeof globalThis.fetch;
  readonly url: string;
  readonly init: RequestInit;
  readonly timeoutMs: number;
  readonly allowedStatuses: readonly number[];
  readonly failureCode: string;
}): Promise<unknown> {
  let response: BoundedHttpResponse;
  try {
    response = await fetchBoundedly(
      input.fetch,
      input.url,
      input.init,
      input.timeoutMs,
    );
  } catch {
    fail(input.failureCode);
  }
  if (!input.allowedStatuses.includes(response.status)) {
    discardBoundedResponse(response);
    fail(input.failureCode);
  }
  return readBoundedResponse(response);
}

export async function signInDisposableSupabase(input: {
  readonly fetch: typeof globalThis.fetch;
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  readonly email: string;
  readonly password: string;
  readonly timeoutMs: number;
}): Promise<unknown> {
  return exactJsonRequest({
    fetch: input.fetch,
    url: `${input.supabaseUrl}/auth/v1/token?grant_type=password`,
    init: {
      method: "POST",
      redirect: "error",
      headers: {
        apikey: input.publishableKey,
        Authorization: `Bearer ${input.publishableKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: input.email, password: input.password }),
    },
    timeoutMs: input.timeoutMs,
    allowedStatuses: [200, 201],
    failureCode: "supabase_auth_failed",
  });
}

function validateReplayPair(
  first: LoadedReplayReceipt,
  second: LoadedReplayReceipt,
  candidateSha: string,
  expectedTargetIdentitySha256: string,
  expectedRootCaDerSha256: string,
): number {
  const firstValue = first.value;
  const secondValue = second.value;
  const tombstones = firstValue.ledgerTombstoneCount;
  if (
    tombstones < 1 ||
    firstValue.targetIdentitySha256 !== expectedTargetIdentitySha256 ||
    secondValue.targetIdentitySha256 !== expectedTargetIdentitySha256 ||
    firstValue.transportRootCaDerSha256 !== expectedRootCaDerSha256 ||
    secondValue.transportRootCaDerSha256 !== expectedRootCaDerSha256 ||
    !recoveryCandidateBindingsExact(candidateSha, [
      firstValue.migrationCandidateSha,
      secondValue.migrationCandidateSha,
    ]) ||
    firstValue.counts.seen !== tombstones ||
    firstValue.counts.newlyApplied !== tombstones ||
    firstValue.counts.alreadyApplied !== 0 ||
    secondValue.counts.seen !== tombstones ||
    secondValue.counts.newlyApplied !== 0 ||
    secondValue.counts.alreadyApplied !== tombstones ||
    firstValue.semanticProjectionSha256 !==
      secondValue.semanticProjectionSha256 ||
    firstValue.ledgerCurrentSha256 !== secondValue.ledgerCurrentSha256 ||
    firstValue.ledgerImmutableSetSha256 !== secondValue.ledgerImmutableSetSha256
  )
    fail("replay_idempotency_invalid");
  return tombstones;
}

export function recoveryCandidateBindingsExact(
  candidateSha: string,
  bindings: readonly string[],
): boolean {
  return (
    CANDIDATE_SHA.test(candidateSha) &&
    bindings.length > 0 &&
    bindings.every((binding) => binding === candidateSha)
  );
}

export async function verifyRecoveredPostgresApplication(
  argv: readonly string[],
  overrides: Partial<RecoveredApplicationDependencies> = {},
): Promise<Record<string, unknown>> {
  const dependencies: RecoveredApplicationDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  const args = parseArguments(argv);
  const runtimeUrl = exactPrivateText(args.runtimeUrlFile, 20, 8_192);
  const maintenanceUrl = exactPrivateText(args.maintenanceUrlFile, 20, 8_192);
  const redisUrl = exactPrivateText(args.redisUrlFile, 20, 8_192);
  const supabasePublishableKey = exactPrivateText(
    args.supabasePublishableKeyFile,
    20,
    512,
  );
  const authEmail = exactPrivateText(args.authEmailFile, 3, 320).toLowerCase();
  const authPassword = exactPrivateText(args.authPasswordFile, 12, 512);
  const redisSentinel = exactPrivateText(args.redisSentinelFile, 32, 512);
  const sourceEvidenceSigningSecret = exactPrivateText(
    args.sourceEvidenceSigningSecretFile,
    32,
    512,
  );
  if (
    !SUPABASE_PUBLISHABLE_KEY.test(supabasePublishableKey) ||
    sha256(authEmail) !== args.expectedAuthEmailSha256 ||
    sha256(supabasePublishableKey) !== args.expectedSupabasePublishableKeySha256
  )
    fail("auth_credential_identity_mismatch");

  assertRecoveryIdentityBoundary({
    candidateSha: args.candidateSha,
    runtimeUrl,
    runtimeUrlSha256: args.expectedRuntimeUrlSha256,
    maintenanceUrl,
    maintenanceUrlSha256: args.expectedMaintenanceUrlSha256,
    redisUrl,
    redisUrlSha256: args.expectedRedisUrlSha256,
    supabaseUrl: args.supabaseUrl,
    supabaseOriginSha256: args.expectedSupabaseOriginSha256,
    supabasePublishableKeySha256: sha256(supabasePublishableKey),
    expectedSupabasePublishableKeySha256:
      args.expectedSupabasePublishableKeySha256,
    productionSupabasePublishableKeySha256:
      args.productionSupabasePublishableKeySha256,
    permanentStagingSupabasePublishableKeySha256:
      args.permanentStagingSupabasePublishableKeySha256,
    railwayProjectId: args.railwayProjectId,
    railwayEnvironmentId: args.railwayEnvironmentId,
    railwayServiceId: args.railwayServiceId,
    productionRailwayProjectId: args.productionRailwayProjectId,
    productionRailwayEnvironmentId: args.productionRailwayEnvironmentId,
    productionRailwayServiceId: args.productionRailwayServiceId,
    permanentStagingRailwayProjectId: args.permanentStagingRailwayProjectId,
    permanentStagingRailwayEnvironmentId:
      args.permanentStagingRailwayEnvironmentId,
    permanentStagingRailwayServiceId: args.permanentStagingRailwayServiceId,
    databaseResourceId: args.databaseResourceId,
    productionDatabaseResourceId: args.productionDatabaseResourceId,
    permanentStagingDatabaseResourceId: args.permanentStagingDatabaseResourceId,
    productionDatabaseUrlSha256: args.productionDatabaseUrlSha256,
    permanentStagingDatabaseUrlSha256: args.permanentStagingDatabaseUrlSha256,
    redisResourceId: args.redisResourceId,
    productionRedisResourceId: args.productionRedisResourceId,
    permanentStagingRedisResourceId: args.permanentStagingRedisResourceId,
    productionRedisUrlSha256: args.productionRedisUrlSha256,
    permanentStagingRedisUrlSha256: args.permanentStagingRedisUrlSha256,
  });

  const first = loadReplayReceipt(args.firstReplayReceipt);
  const second = loadReplayReceipt(args.secondReplayReceipt);
  const tombstones = validateReplayPair(
    first,
    second,
    args.candidateSha,
    args.expectedTargetIdentitySha256,
    args.expectedRootCaDerSha256,
  );

  const rootCaBytes = readTrustedRegularFile(args.rootCaFile, {
    minBytes: 1,
    maxBytes: 64 * 1024,
    requireOwner: true,
    requirePrivate: true,
  });
  let rootCaPem = rootCaBytes.toString("utf8");
  rootCaBytes.fill(0);
  const parsedRuntimeUrl = parsePostgresRailwayStockLocalhostCaUrl(runtimeUrl);
  const parsedMaintenanceUrl =
    parsePostgresRailwayStockLocalhostCaUrl(maintenanceUrl);
  if (
    parsedRuntimeUrl.sourceUrlAuthority.hostname !==
      parsedMaintenanceUrl.sourceUrlAuthority.hostname ||
    parsedRuntimeUrl.sourceUrlAuthority.port !==
      parsedMaintenanceUrl.sourceUrlAuthority.port
  )
    fail("database_role_boundary_invalid");
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0)
    fail("file_unsafe");

  const runtimeStageBoundary = dependencies.createRuntimeStageBoundary(
    args.compiledArtifactRoot,
    args.runtimeStageRoot,
  );
  const childDirectory = runtimeStageBoundary.directory;
  const stagedArtifactRoot = path.join(childDirectory, "dist");
  const entrypoint = path.join(stagedArtifactRoot, "src", "server.js");
  let stagedArtifactSnapshot: StagedArtifactSnapshot | null = null;
  let compiledArtifactSha256: string;
  let compiledEntrypointSha256: string;
  let runtimeDependencyArtifactSha256: string;
  let runtimeDependencyPackageLockSha256: string;
  let runtimeDependencyPackageCount: number;
  let runtimeDependencyFileCount: number;
  let runtimeDependencyBytes: number;
  try {
    fs.chmodSync(childDirectory, 0o700);
    const childDirectoryStat = fs.lstatSync(childDirectory, { bigint: true });
    if (
      fs.realpathSync(childDirectory) !== childDirectory ||
      !childDirectoryStat.isDirectory() ||
      childDirectoryStat.isSymbolicLink() ||
      childDirectoryStat.uid !== BigInt(uid) ||
      (childDirectoryStat.mode & 0o777n) !== 0o700n
    )
      fail("child_directory_unsafe");
    stagedArtifactSnapshot = stageCompiledApplicationArtifact(
      args.compiledArtifactRoot,
      stagedArtifactRoot,
      {
        nodeModulesRoot: runtimeStageBoundary.nodeModulesRoot,
        packageLockFile: runtimeStageBoundary.packageLockFile,
        expectedArtifactSha256: args.expectedRuntimeDependencyArtifactSha256,
      },
    );
    compiledArtifactSha256 = stagedArtifactSnapshot.artifactSha256;
    runtimeDependencyArtifactSha256 =
      stagedArtifactSnapshot.runtimeDependencyArtifactSha256;
    runtimeDependencyPackageLockSha256 =
      stagedArtifactSnapshot.runtimeDependencyPackageLockSha256;
    runtimeDependencyPackageCount =
      stagedArtifactSnapshot.runtimeDependencyPackageCount;
    runtimeDependencyFileCount =
      stagedArtifactSnapshot.runtimeDependencyFileCount;
    runtimeDependencyBytes = stagedArtifactSnapshot.runtimeDependencyBytes;
    if (
      compiledArtifactSha256 !== args.expectedCompiledArtifactSha256 ||
      hashCompiledApplicationArtifactInternal(stagedArtifactRoot, true) !==
        compiledArtifactSha256
    )
      fail("compiled_artifact_mismatch");
    compiledEntrypointSha256 = hashTrustedArtifactFile(entrypoint);
    if (compiledEntrypointSha256 !== args.expectedCompiledEntrypointSha256) {
      fail("compiled_entrypoint_mismatch");
    }
  } catch (error) {
    let cleanupFailed = false;
    try {
      runtimeStageBoundary.assertExact();
    } catch {
      cleanupFailed = true;
    }
    try {
      runtimeStageBoundary.close();
    } catch {
      cleanupFailed = true;
    }
    if (stagedArtifactSnapshot) {
      try {
        removeStagedArtifactExactly(
          stagedArtifactSnapshot,
          dependencies.removeTemporaryDirectory,
        );
      } catch {
        cleanupFailed = true;
      }
    } else {
      try {
        if (fs.readdirSync(childDirectory).length !== 0) {
          cleanupFailed = true;
        } else {
          dependencies.removeTemporaryDirectory(childDirectory);
        }
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) fail("compiled_artifact_cleanup_failed");
    throw error;
  }

  let transport: PostgresRailwayStockLocalhostCaTransport | null = null;
  let runtimePool: PoolBoundary | null = null;
  let maintenancePool: PoolBoundary | null = null;
  let child: ManagedRecoveryChild | null = null;
  let providerAccessToken: string | null = null;
  let appSessionToken: string | null = null;
  let appSessionCookieHeader: string | null = null;
  let providerSessionId: string | null = null;
  let authSubject: string | null = null;
  let applicationReadyAt: string | null = null;
  let childTerminatedExact = false;
  let runtimeDependencyBoundaryExact = false;
  let authoritiesClosedExact = false;
  let providerSessionLogoutExact = false;
  let appSessionRevokedExact = false;
  let ceremonyPassed = false;
  let mainFailure: unknown = null;

  try {
    transport = await dependencies.openTransport({
      profile: "railway-stock-localhost-ca-v1",
      rootCaFile: args.rootCaFile,
      expectedRootCaDerSha256: args.expectedRootCaDerSha256,
      expectedUid: uid,
      sourceUrlAuthority: parsedRuntimeUrl.sourceUrlAuthority,
    });
    await transport.assertExact();
    runtimePool = dependencies.createPool(
      poolConfig(
        runtimeUrl,
        transport,
        "pintpath_runtime",
        "pintpath-recovered-application-verifier-runtime",
      ),
    );
    maintenancePool = dependencies.createPool(
      poolConfig(
        maintenanceUrl,
        transport,
        "pintpath_maintenance",
        "pintpath-recovered-application-verifier-maintenance",
      ),
    );
    await verifyDatabaseSmoke(runtimePool, tombstones);
    await verifyMaintenanceBoundary(maintenancePool);
    await transport.assertExact();

    runtimeStageBoundary.assertExact();
    assertStagedArtifactSnapshot(stagedArtifactSnapshot);
    if (
      hashCompiledApplicationArtifactInternal(stagedArtifactRoot, true) !==
        compiledArtifactSha256 ||
      hashTrustedArtifactFile(entrypoint) !== compiledEntrypointSha256
    )
      fail("compiled_artifact_changed");
    child = dependencies.spawn(process.execPath, [entrypoint], {
      cwd: childDirectory,
      env: childEnvironment({
        args,
        runtimeUrl,
        maintenanceUrl,
        redisUrl,
        rootCaPem,
        supabasePublishableKey,
        redisSentinel,
        sourceEvidenceSigningSecret,
      }),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    rootCaPem = "";
    const output = attachBoundedRedactedOutput({
      child,
      limitBytes: args.outputLimitBytes,
      knownSecrets: [
        runtimeUrl,
        maintenanceUrl,
        redisUrl,
        supabasePublishableKey,
        authEmail,
        authPassword,
        redisSentinel,
        sourceEvidenceSigningSecret,
      ],
    });
    const baseUrl = `http://127.0.0.1:${args.appPort}`;
    await waitForRecoveryProbe({
      fetch: dependencies.fetch,
      url: `${baseUrl}/startup`,
      route: "startup",
      candidateSha: args.candidateSha,
      startupTimeoutMs: args.startupTimeoutMs,
      requestTimeoutMs: args.requestTimeoutMs,
      now: dependencies.now,
      sleep: dependencies.sleep,
      childExited: () => child!.exitCode !== null || child!.signalCode !== null,
      outputExceeded: output.exceeded,
    });
    await waitForRecoveryProbe({
      fetch: dependencies.fetch,
      url: `${baseUrl}/ready`,
      route: "ready",
      candidateSha: args.candidateSha,
      startupTimeoutMs: args.startupTimeoutMs,
      requestTimeoutMs: args.requestTimeoutMs,
      now: dependencies.now,
      sleep: dependencies.sleep,
      childExited: () => child!.exitCode !== null || child!.signalCode !== null,
      outputExceeded: output.exceeded,
    });
    if (output.exceeded()) fail("child_output_limit_exceeded");

    const signIn = await signInDisposableSupabase({
      fetch: dependencies.fetch,
      supabaseUrl: args.supabaseUrl,
      publishableKey: supabasePublishableKey,
      email: authEmail,
      password: authPassword,
      timeoutMs: args.requestTimeoutMs,
    });
    if (!isRecord(signIn) || typeof signIn.access_token !== "string") {
      fail("supabase_auth_failed");
    }
    providerAccessToken = signIn.access_token;
    const parsedAccessToken = assertDisposableSupabaseAccessTokenIdentity(
      providerAccessToken,
      args.supabaseUrl,
      dependencies.now(),
    );
    authSubject = parsedAccessToken.subject;
    providerSessionId = parsedAccessToken.sessionId;
    if (
      sha256(authSubject) !== args.expectedAuthSubjectSha256 ||
      !isRecord(signIn.user) ||
      signIn.user.id !== authSubject ||
      String(signIn.user.email ?? "").toLowerCase() !== authEmail
    )
      fail("auth_subject_mismatch");
    proveCrossProjectTokenRejectedLocally(args.supabaseUrl, dependencies.now());
    await restoredAccount(runtimePool, authSubject, authEmail);

    const exchangeUrl = `${baseUrl}/api/business/auth/supabase-session`;
    let exchangeResponse: BoundedHttpResponse;
    try {
      exchangeResponse = await fetchBoundedly(
        dependencies.fetch,
        exchangeUrl,
        {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Origin: baseUrl,
        },
        body: JSON.stringify({ accessToken: providerAccessToken }),
        },
        args.requestTimeoutMs,
      );
    } catch {
      fail("app_auth_exchange_failed");
    }
    if (exchangeResponse.status !== 200) {
      discardBoundedResponse(exchangeResponse);
      fail("app_auth_exchange_failed");
    }
    let appSession;
    try {
      appSession = extractExactAppSessionCookie(
        exchangeResponse.setCookieHeaders,
        exchangeUrl,
      );
    } catch {
      fail("app_auth_exchange_failed");
    }
    appSessionToken = appSession.token;
    appSessionCookieHeader = appSession.cookieHeader;
    let exchange: unknown;
    try {
      exchange = readBoundedResponse(exchangeResponse);
    } catch {
      fail("app_auth_exchange_failed");
    }
    if (
      !isRecord(exchange) ||
      exchange.ok !== true ||
      !isRecord(exchange.data) ||
      Object.prototype.hasOwnProperty.call(exchange.data, "token") ||
      !isRecord(exchange.data.account) ||
      exchange.data.account.id !== authSubject ||
      exchange.data.account.role !== "user" ||
      !Array.isArray(exchange.data.counterStaffAssignments) ||
      exchange.data.counterStaffAssignments.length !== 0
    )
      fail("app_auth_exchange_failed");

    const accountPayload = await exactJsonRequest({
      fetch: dependencies.fetch,
      url: `${baseUrl}/api/business/account`,
      init: {
        method: "GET",
        redirect: "error",
        headers: { Cookie: appSessionCookieHeader },
      },
      timeoutMs: args.requestTimeoutMs,
      allowedStatuses: [200],
      failureCode: "authenticated_boundary_failed",
    });
    assertAuthenticatedAccountBoundary({
      payload: accountPayload,
      expectedSubject: authSubject,
      expectedEmail: authEmail,
      forbiddenValues: [
        providerAccessToken,
        appSessionToken,
        authPassword,
        supabasePublishableKey,
        runtimeUrl,
        maintenanceUrl,
        redisUrl,
      ],
    });
    await assertNoOtherAccountEmailLeakage(
      runtimePool,
      authSubject,
      accountPayload,
    );
    const adminDenied = await fetchBoundedly(
      dependencies.fetch,
      `${baseUrl}/api/admin/status`,
      {
        method: "GET",
        redirect: "error",
        headers: { Cookie: appSessionCookieHeader },
      },
      args.requestTimeoutMs,
    );
    discardBoundedResponse(adminDenied);
    if (adminDenied.status !== 403) fail("admin_boundary_failed");
    const deletionDenied = await fetchBoundedly(
      dependencies.fetch,
      `${baseUrl}/api/business/account/delete-request`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Cookie: appSessionCookieHeader,
          "Content-Type": "application/json",
          Origin: baseUrl,
        },
        body: JSON.stringify({ reason: "recovery-boundary-proof" }),
      },
      args.requestTimeoutMs,
    );
    discardBoundedResponse(deletionDenied);
    if (deletionDenied.status !== 503) fail("deletion_boundary_failed");
    await transport.assertExact();
    applicationReadyAt = canonicalTimestampAfter(dependencies.now());
    ceremonyPassed = true;
  } catch (error) {
    mainFailure = error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (
      appSessionToken &&
      appSessionCookieHeader &&
      child &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      try {
        const baseUrl = `http://127.0.0.1:${args.appPort}`;
        const logout = await exactJsonRequest({
          fetch: dependencies.fetch,
          url: `${baseUrl}/api/business/auth/logout`,
          init: {
            method: "POST",
            redirect: "error",
            headers: {
              Cookie: appSessionCookieHeader,
              Origin: baseUrl,
            },
          },
          timeoutMs: args.requestTimeoutMs,
          allowedStatuses: [200],
          failureCode: "app_session_cleanup_failed",
        });
        if (
          !isRecord(logout) ||
          logout.ok !== true ||
          !isRecord(logout.data) ||
          logout.data.revoked !== true
        )
          fail("app_session_cleanup_failed");
        const rejected = await fetchBoundedly(
          dependencies.fetch,
          `${baseUrl}/api/business/account`,
          {
            method: "GET",
            redirect: "error",
            headers: { Cookie: appSessionCookieHeader },
          },
          args.requestTimeoutMs,
        );
        discardBoundedResponse(rejected);
        if (rejected.status !== 401) fail("app_session_cleanup_failed");
        if (!runtimePool || !authSubject || !providerSessionId) {
          fail("app_session_cleanup_failed");
        }
        await assertSessionRevoked(
          runtimePool,
          appSessionToken,
          authSubject,
          providerSessionId,
        );
        appSessionRevokedExact = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
    } else if (appSessionToken || appSessionCookieHeader) {
      cleanupFailures.push(new Error("app_session_cleanup_failed"));
    }
    if (providerAccessToken) {
      try {
        const response = await fetchBoundedly(
          dependencies.fetch,
          `${args.supabaseUrl}/auth/v1/logout?scope=local`,
          {
            method: "POST",
            redirect: "error",
            headers: {
              apikey: supabasePublishableKey,
              Authorization: `Bearer ${providerAccessToken}`,
            },
          },
          args.requestTimeoutMs,
        );
        const responseOk = response.status >= 200 && response.status < 300;
        discardBoundedResponse(response);
        if (!responseOk) fail("provider_session_cleanup_failed");
        providerSessionLogoutExact = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (child) {
      try {
        childTerminatedExact = await terminateChild(
          child,
          args.shutdownTimeoutMs,
          ceremonyPassed,
        );
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      authoritiesClosedExact = await closeRecoveryAuthoritiesBoundedly({
        pools: [runtimePool, maintenancePool].filter(
          (pool): pool is PoolBoundary => pool !== null,
        ),
        transport,
        timeoutMs: args.closeTimeoutMs,
      });
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      runtimeStageBoundary.assertExact();
      runtimeStageBoundary.close();
      runtimeDependencyBoundaryExact = true;
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      removeStagedArtifactExactly(
        stagedArtifactSnapshot,
        dependencies.removeTemporaryDirectory,
      );
    } catch (error) {
      cleanupFailures.push(error);
    }
    providerAccessToken = null;
    appSessionToken = null;
    appSessionCookieHeader = null;
    rootCaPem = "";
    if (cleanupFailures.length > 0) {
      mainFailure = new Error("recovered_postgres_application_cleanup_failed");
    }
  }

  if (mainFailure) throw mainFailure;
  if (
    !ceremonyPassed ||
    !applicationReadyAt ||
    !authSubject ||
    !appSessionRevokedExact ||
    !providerSessionLogoutExact ||
    !childTerminatedExact ||
    !runtimeDependencyBoundaryExact ||
    !authoritiesClosedExact
  )
    fail("incomplete");

  const completedAt = canonicalTimestampAfter(
    dependencies.now(),
    applicationReadyAt,
  );
  const withoutHash = {
    schemaVersion: 1,
    kind: "pintpath-recovered-postgres-application-smoke",
    status: "verified",
    ok: true,
    candidateSha: args.candidateSha,
    targetIdentitySha256: args.expectedTargetIdentitySha256,
    applicationReadyAt,
    completedAt,
    checkedAt: completedAt,
    firstReplayReceiptSha256: first.sha256,
    secondReplayReceiptSha256: second.sha256,
    semanticProjectionSha256: first.value.semanticProjectionSha256,
    tombstoneCount: tombstones,
    compiledArtifactSha256,
    compiledEntrypointSha256,
    runtimeDependencyArtifactSha256,
    runtimeDependencyPackageLockSha256,
    runtimeDependencyPackageCount,
    runtimeDependencyFileCount,
    runtimeDependencyBytes,
    compiledArtifactExact: true,
    runtimeDependencyBoundaryExact,
    candidateArtifactBindingExact: true,
    compiledApplicationStarted: true,
    startupProbeExact: true,
    startupRouteReady: true,
    readyProbeExact: true,
    readyRouteReady: true,
    authenticatedBoundaryExact: true,
    authenticatedRuntimeExact: true,
    authSubjectSha256: sha256(authSubject),
    authEmailSha256: sha256(authEmail),
    supabaseOriginSha256: args.expectedSupabaseOriginSha256,
    supabasePublishableKeySha256: sha256(supabasePublishableKey),
    disposableSupabaseCredentialExact: true,
    restoredAuthAccountPreexistingExact: true,
    noAdminOrVenueElevationExact: true,
    adminBoundaryDeniedExact: true,
    deletionMutationDeniedExact: true,
    noPrivateDataLeakageExact: true,
    crossProjectTokenRejectedLocally: true,
    crossProjectTokenRejectedLocallyExact: true,
    crossProjectTokenParserRejectedLocallyExact: true,
    appSessionRevokedExact,
    providerSessionLogoutExact,
    runtimeRoleExact: true,
    maintenanceRoleRestricted: true,
    applicationStateReady: true,
    deletionPrivacyReconciled: true,
    automaticMaintenanceWorkersExternalWritesDisabledExact: true,
    automaticStartupMaintenanceWorkersExternalWritesDisabledExact: true,
    runtimeMaintenanceUrlsDistinctExact: true,
    disposableRailwayIdentityExact: true,
    disposableSupabaseIdentityExact: true,
    disposableRedisIdentityExact: true,
    productionPermanentStagingReuseRejectedExact: true,
    childOutputBoundedRedactedExact: true,
    childTerminatedExact,
    applicationChildTerminated: true,
    databaseAuthoritiesClosedExact: authoritiesClosedExact,
    transportClosedExact: authoritiesClosedExact,
    runtimeDatabaseUrlSha256: args.expectedRuntimeUrlSha256,
    maintenanceDatabaseUrlSha256: args.expectedMaintenanceUrlSha256,
    redisUrlSha256: args.expectedRedisUrlSha256,
    transportProfile: "railway-stock-localhost-ca-v1",
    transportRootCaDerSha256: args.expectedRootCaDerSha256,
  } as const;
  return {
    ...withoutHash,
    receiptSha256: sha256(canonicalPostgresBackupJson(withoutHash)),
  };
}

function safeFailureCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^recovered_postgres_application_[a-z0-9_]{1,80}$/.test(error.message)
  )
    return error.message;
  return "recovered_postgres_application_unexpected_failure";
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyRecoveredPostgresApplication(
      process.argv.slice(2),
    );
    process.stdout.write(canonicalPostgresBackupJson(result));
  } catch (error) {
    process.stdout.write(
      canonicalPostgresBackupJson({
        schemaVersion: 1,
        ok: false,
        failureCode: safeFailureCode(error),
      }),
    );
    process.exitCode = 1;
  }
}
