import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

import { isCanonicalProductionRuntime } from "../lib/deployment-environment.js";
import { parseAccountDeletionNotificationKeyring } from "../lib/account-deletion-notification-worker.js";
import { OPENAI_MENU_OCR_COST_BOUND_MODEL } from "../lib/external-provider-cost-budget.js";
import {
  assertPostgresRailwayStockLocalhostRootCaPem,
  parsePostgresRailwayStockLocalhostCaUrl,
} from "../lib/postgres-railway-stock-localhost-ca.js";
import {
  hasExactLegacySupabaseRoleJwt,
  isExactSupabaseNewKey,
  resolveExactOperationalOffsiteBackupBucket,
} from "../lib/supabase-key-format.js";

dotenv.config({ quiet: true });

function sanitizeEnvString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();

  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function normalizeHttpUrlString(value: unknown): unknown {
  const trimmed = sanitizeEnvString(value);
  if (typeof trimmed !== "string") {
    return trimmed;
  }

  if (trimmed.length === 0) {
    return undefined;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }

  return trimmed;
}

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();

    if (["1", "true", "yes", "on"].includes(normalised)) {
      return true;
    }

    if (["0", "false", "no", "off"].includes(normalised)) {
      return false;
    }
  }

  return value;
}, z.boolean());

const exactBooleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (normalised === "true") return true;
    if (normalised === "false") return false;
  }

  return value;
}, z.boolean());

const menuOcrModelFromEnv = z.preprocess(
  sanitizeEnvString,
  z.enum(["gpt-5.6-sol", "gpt-4.1", OPENAI_MENU_OCR_COST_BOUND_MODEL]),
);

const demoBillingModeFromEnv = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return process.env.NODE_ENV === "production" ? false : true;
  }

  return value;
}, booleanFromEnv);

const optionalStringFromEnv = z.preprocess((value) => {
  const trimmed = sanitizeEnvString(value);
  if (typeof trimmed !== "string") {
    return trimmed;
  }
  return trimmed.length === 0 ? undefined : trimmed;
}, z.string().min(1).optional());

const optionalPostgresRootCaPemFromEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return value.length === 0 ? undefined : value;
}, z.string().min(1).max(64 * 1024).refine(
  (value) => !value.includes("\0"),
  "Postgres root CA PEM must not contain a NUL byte.",
).optional());

const optionalPositiveIntegerFromEnv = z.preprocess((value) => {
  const trimmed = sanitizeEnvString(value);
  if (typeof trimmed === "string" && trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}, z.coerce.number().int().min(1).optional());

const optionalHttpUrlFromEnv = z.preprocess((value) => {
  const normalised = normalizeHttpUrlString(value);
  if (typeof normalised !== "string") {
    return normalised;
  }

  return normalised.length === 0 ? undefined : normalised;
}, z.string().url().optional());

const optionalSha256FromEnv = z.preprocess((value) => {
  const trimmed = sanitizeEnvString(value);
  if (typeof trimmed !== "string" || trimmed.length === 0) {
    return undefined;
  }
  return trimmed.toLowerCase();
}, z.string().regex(/^[a-f0-9]{64}$/).optional());

type HostedSupabaseKeyValidationMode =
  | "permanent-staging-bootstrap"
  | "permanent-staging-complete"
  | "account-deletion-rehearsal";

const canonicalProductionSupabaseOrigin = "https://auth.pintpath.au";
const permanentStagingSupabaseOrigin = "https://bbfibbadwjxzrcdncavy.supabase.co";
const operationalOffsiteSupabaseOrigin = "https://hfbmhdxrwtihukmixxta.supabase.co";

function assertPublicSupabaseKeySafe(input: {
  parsedValue: string | undefined;
  rawValue: string | undefined;
}): void {
  if (input.parsedValue === undefined) return;
  if (
    input.rawValue === input.parsedValue
    && (
      isExactSupabaseNewKey(input.parsedValue, "publishable")
      || hasExactLegacySupabaseRoleJwt(input.parsedValue, "anon")
    )
  ) return;
  throw new Error(
    "SUPABASE_ANON_KEY must be an exact sb_publishable_ key or a structurally valid legacy JWT with role=anon; refusing to expose a secret, malformed, or non-anon value through public config.",
  );
}

function assertCompatibleSupabaseServiceKey(input: {
  name: "SUPABASE_SERVICE_ROLE_KEY" | "OFFSITE_BACKUP_SERVICE_ROLE_KEY";
  parsedValue: string | undefined;
  rawValue: string | undefined;
}): void {
  if (
    input.parsedValue !== undefined
    && input.rawValue === input.parsedValue
    && (
      isExactSupabaseNewKey(input.parsedValue, "secret")
      || hasExactLegacySupabaseRoleJwt(input.parsedValue, "service_role")
    )
  ) return;
  throw new Error(
    `${input.name} must be an exact sb_secret_ key or a structurally valid legacy JWT with role=service_role; no key value is emitted.`,
  );
}

function assertHostedSupabaseKeyBoundary(input: {
  mode: HostedSupabaseKeyValidationMode;
  primaryUrl: string | undefined;
  rawPrimaryUrl: string | undefined;
  anonKey: string | undefined;
  rawAnonKey: string | undefined;
  serviceKey: string | undefined;
  rawServiceKey: string | undefined;
  offsiteServiceKey: string | undefined;
  rawOffsiteServiceKey: string | undefined;
  offsiteUrl: string | undefined;
  rawOffsiteUrl: string | undefined;
  rawOffsiteBucket: string | undefined;
}): void {
  if (
    input.primaryUrl !== permanentStagingSupabaseOrigin
    || input.rawPrimaryUrl !== permanentStagingSupabaseOrigin
  ) {
    throw new Error(
      `Hosted Supabase key validation (${input.mode}) requires SUPABASE_URL to be the exact reviewed permanent-staging HTTPS origin; no configured value is emitted.`,
    );
  }
  const requiredKeys = [
    ["SUPABASE_ANON_KEY", "publishable", input.anonKey, input.rawAnonKey],
    ["SUPABASE_SERVICE_ROLE_KEY", "secret", input.serviceKey, input.rawServiceKey],
  ] as const;
  for (const [name, format, parsedValue, rawValue] of requiredKeys) {
    if (
      parsedValue === undefined
      || rawValue !== parsedValue
      || !isExactSupabaseNewKey(parsedValue, format)
    ) {
      throw new Error(
        `Hosted Supabase key validation (${input.mode}) requires ${name} to use the exact sb_${format}_[A-Za-z0-9_-]{20,220} format; no key value is emitted.`,
      );
    }
  }

  const inheritedOffsiteConfiguration = [
    input.offsiteUrl,
    input.offsiteServiceKey,
    input.rawOffsiteUrl,
    input.rawOffsiteServiceKey,
    input.rawOffsiteBucket,
  ].some((value) => value !== undefined && value !== "");
  if (inheritedOffsiteConfiguration) {
    throw new Error(
      `Hosted Supabase key validation (${input.mode}) prohibits OFFSITE_BACKUP_SUPABASE_URL, OFFSITE_BACKUP_SERVICE_ROLE_KEY, and OFFSITE_BACKUP_BUCKET. Permanent staging must not inherit production operational-backup authority; use a separately registered isolated staging destination before enabling an off-site proof. No configured value is emitted.`,
    );
  }
}

function canonicalSupabaseProjectRef(value: string, variableName: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const match = hostname.match(/^([a-z0-9]{20})\.supabase\.co$/);
  if (
    url.protocol !== "https:" ||
    !match ||
    url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${variableName} must be the canonical HTTPS project origin https://<project-ref>.supabase.co with no alias, port, path, query, or fragment.`,
    );
  }
  return match[1]!;
}

function assertTlsPostgresUrl(value: string | undefined, variableName: string): void {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error(`${variableName} must be a valid TLS Postgres connection URL.`);
  }

  const sslModes = url.searchParams
    .getAll("sslmode")
    .map((sslMode) => sslMode.toLowerCase());
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !url.hostname
    || !url.username
    || !url.pathname
    || url.pathname === "/"
    || sslModes.length !== 1
    || !["require", "verify-ca", "verify-full"].includes(sslModes[0] ?? "")
    || url.hash
  ) {
    throw new Error(
      `${variableName} must use postgres:// or postgresql:// with a host, application user, database, and sslmode=require, verify-ca, or verify-full.`,
    );
  }
}

function connectionUrlSha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function parseConnectionDigestList(
  value: string | undefined,
  variableName: string,
  minimumCount = 2,
): string[] {
  const digests = (value ?? "")
    .split(",")
    .map((digest) => digest.trim().toLowerCase())
    .filter(Boolean);
  const uniqueDigests = [...new Set(digests)];
  if (
    digests.length < minimumCount
    || uniqueDigests.length !== digests.length
    || digests.some((digest) => !/^[a-f0-9]{64}$/.test(digest))
  ) {
    const minimumLabel = minimumCount === 2 ? "two" : String(minimumCount);
    throw new Error(
      `${variableName} must contain at least ${minimumLabel} distinct comma-separated SHA-256 digests for the other registered environments.`,
    );
  }
  return uniqueDigests;
}

function assertPinnedConnectionIdentity(input: {
  connectionUrl: string | undefined;
  expectedDigest: string | undefined;
  forbiddenDigests: string | undefined;
  label: string;
  minimumForbidden?: number;
}): void {
  if (!input.connectionUrl || !input.expectedDigest) {
    throw new Error(
      `${input.label} requires its live connection URL and protected expected SHA-256 identity pin.`,
    );
  }
  const forbidden = parseConnectionDigestList(
    input.forbiddenDigests,
    `PINTPATH_FORBIDDEN_${input.label.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_URL_SHA256S`,
    input.minimumForbidden ?? 2,
  );
  const actual = connectionUrlSha256(input.connectionUrl);
  if (actual !== input.expectedDigest || forbidden.includes(actual) || forbidden.includes(input.expectedDigest)) {
    throw new Error(
      `${input.label} does not match its reviewed environment identity or aliases a forbidden environment.`,
    );
  }
}

const resourceIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const unsafeResourceIdentityPattern = /(?:^|[._:-])(?:change[-_]?me|dummy|example|fake|fixture|placeholder|replace(?:[-_]?with)?|test)(?:$|[._:-])/i;

function isReviewedResourceIdentity(value: string): boolean {
  return resourceIdentityPattern.test(value) && !unsafeResourceIdentityPattern.test(value);
}

function parseResourceIdentityList(
  value: string | undefined,
  variableName: string,
  minimumCount = 2,
): string[] {
  const identities = (value ?? "")
    .split(",")
    .map((identity) => identity.trim())
    .filter(Boolean);
  const uniqueIdentities = [...new Set(identities)];
  if (
    identities.length < minimumCount
    || uniqueIdentities.length !== identities.length
    || identities.some((identity) => !isReviewedResourceIdentity(identity))
  ) {
    const minimumLabel = minimumCount === 2 ? "two" : String(minimumCount);
    throw new Error(
      `${variableName} must contain at least ${minimumLabel} distinct reviewed provider service-instance IDs without fake or placeholder values.`,
    );
  }
  return uniqueIdentities;
}

function assertPinnedResourceIdentity(input: {
  actual: string | undefined;
  expected: string | undefined;
  forbidden: string | undefined;
  label: string;
  minimumForbidden?: number;
}): void {
  if (
    !input.actual
    || !input.expected
    || !isReviewedResourceIdentity(input.actual)
    || !isReviewedResourceIdentity(input.expected)
  ) {
    throw new Error(`${input.label} requires valid live and protected expected provider resource IDs.`);
  }
  const forbidden = parseResourceIdentityList(
    input.forbidden,
    `PINTPATH_FORBIDDEN_${input.label.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_RESOURCE_IDS`,
    input.minimumForbidden ?? 2,
  );
  if (input.actual !== input.expected || forbidden.includes(input.actual) || forbidden.includes(input.expected)) {
    throw new Error(`${input.label} does not match its reviewed provider resource or aliases a forbidden environment.`);
  }
}

function assertForbiddenIdentityPinsAbsent(input: {
  databaseDigests: string | undefined;
  databaseResources: string | undefined;
  redisDigests: string | undefined;
  redisResources: string | undefined;
}): void {
  const configured = [
    ["PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S", input.databaseDigests],
    ["PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS", input.databaseResources],
    ["PINTPATH_FORBIDDEN_REDIS_URL_SHA256S", input.redisDigests],
    ["PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS", input.redisResources],
  ].filter(([, value]) => value !== undefined);
  if (configured.length > 0) {
    throw new Error(
      `Permanent-staging identity bootstrap requires sibling identity lists to remain absent until real production and restore service instances exist: ${configured.map(([name]) => name).join(", ")}.`,
    );
  }
}

function assertPermanentStagingSelfPins(input: {
  databaseExpectedDigest: string | undefined;
  databaseExpectedResource: string | undefined;
  databaseStagingDigest: string | undefined;
  databaseStagingResource: string | undefined;
  redisExpectedDigest: string | undefined;
  redisExpectedResource: string | undefined;
  redisStagingDigest: string | undefined;
  redisStagingResource: string | undefined;
}): void {
  if (
    !input.databaseExpectedDigest
    || input.databaseStagingDigest !== input.databaseExpectedDigest
    || !input.redisExpectedDigest
    || input.redisStagingDigest !== input.redisExpectedDigest
    || !input.databaseExpectedResource
    || input.databaseStagingResource !== input.databaseExpectedResource
    || !input.redisExpectedResource
    || input.redisStagingResource !== input.redisExpectedResource
    || !isReviewedResourceIdentity(input.databaseStagingResource)
    || !isReviewedResourceIdentity(input.redisStagingResource)
  ) {
    throw new Error(
      "Permanent staging requires its named database and Redis URL/resource pins to exactly match the reviewed live staging service-instance identities.",
    );
  }
}

function assertPermanentStagingExcluded(input: {
  databaseForbiddenDigests: string | undefined;
  databaseForbiddenResources: string | undefined;
  databaseStagingDigest: string | undefined;
  databaseStagingResource: string | undefined;
  redisForbiddenDigests: string | undefined;
  redisForbiddenResources: string | undefined;
  redisStagingDigest: string | undefined;
  redisStagingResource: string | undefined;
}): void {
  const databaseDigests = parseConnectionDigestList(
    input.databaseForbiddenDigests,
    "PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S",
  );
  const databaseResources = parseResourceIdentityList(
    input.databaseForbiddenResources,
    "PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS",
  );
  const redisDigests = parseConnectionDigestList(
    input.redisForbiddenDigests,
    "PINTPATH_FORBIDDEN_REDIS_URL_SHA256S",
  );
  const redisResources = parseResourceIdentityList(
    input.redisForbiddenResources,
    "PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS",
  );
  if (
    !input.databaseStagingDigest
    || !databaseDigests.includes(input.databaseStagingDigest)
    || !input.redisStagingDigest
    || !redisDigests.includes(input.redisStagingDigest)
    || !input.databaseStagingResource
    || !isReviewedResourceIdentity(input.databaseStagingResource)
    || !databaseResources.includes(input.databaseStagingResource)
    || !input.redisStagingResource
    || !isReviewedResourceIdentity(input.redisStagingResource)
    || !redisResources.includes(input.redisStagingResource)
  ) {
    throw new Error(
      "Complete production/restore identity configuration must include the named permanent-staging database and Redis URL/resource pins in its forbidden environment lists.",
    );
  }
}

function assertPermanentStagingRailwayIdentity(input: {
  expectedProjectId: string | undefined;
  expectedEnvironmentId: string | undefined;
  expectedServiceId: string | undefined;
}): void {
  const actualProjectId = process.env.RAILWAY_PROJECT_ID?.trim();
  const actualEnvironmentId = process.env.RAILWAY_ENVIRONMENT_ID?.trim();
  const actualServiceId = process.env.RAILWAY_SERVICE_ID?.trim();
  if (
    !input.expectedProjectId
    || !input.expectedEnvironmentId
    || !input.expectedServiceId
    || !isReviewedResourceIdentity(input.expectedProjectId)
    || !isReviewedResourceIdentity(input.expectedEnvironmentId)
    || !isReviewedResourceIdentity(input.expectedServiceId)
    || !actualProjectId
    || !isReviewedResourceIdentity(actualProjectId)
    || !actualEnvironmentId
    || !isReviewedResourceIdentity(actualEnvironmentId)
    || !actualServiceId
    || !isReviewedResourceIdentity(actualServiceId)
    || actualProjectId !== input.expectedProjectId
    || actualEnvironmentId !== input.expectedEnvironmentId
    || actualServiceId !== input.expectedServiceId
  ) {
    throw new Error(
      "Permanent staging must exactly match its protected Railway project/environment/service identity tuple.",
    );
  }
}

function assertRailwayServiceInstanceIdentity(
  value: string | undefined,
  railwayEnvironmentId: string | undefined,
  label: string,
): void {
  const parts = value?.split(":") ?? [];
  if (
    !railwayEnvironmentId
    || parts.length !== 3
    || parts[0] !== "railway"
    || parts[1] !== railwayEnvironmentId
    || !isReviewedResourceIdentity(parts[2] ?? "")
  ) {
    throw new Error(
      `${label} must use the environment-specific Railway service-instance identity railway:<environment-id>:<service-id>, not a shared top-level service ID.`,
    );
  }
}

function assertCanonicalRestoreRedisUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Restore rehearsal REDIS_URL must be the staging Redis private Railway URL.");
  }
  if (
    !["redis:", "rediss:"].includes(url.protocol) ||
    url.hostname.toLowerCase() !== "redis.railway.internal" ||
    url.port !== "6379" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash ||
    !url.username ||
    !url.password
  ) {
    throw new Error(
      "Restore rehearsal REDIS_URL must use the authenticated redis.railway.internal:6379 endpoint from the staging Redis service reference.",
    );
  }
}

const timeZoneFromEnv = z.preprocess(
  sanitizeEnvString,
  z.string().min(1).refine((value) => {
    try {
      new Intl.DateTimeFormat("en-AU", { timeZone: value }).format(new Date(0));
      return true;
    } catch {
      return false;
    }
  }, "Use a valid IANA timezone, for example Australia/Melbourne."),
);

function isSafeConfiguredEmail(value: string): boolean {
  if (/[\r\n]/.test(value)) return false;
  const friendlyAddress = value.match(/^[^<>]*<([^<>]+)>$/);
  const address = (friendlyAddress?.[1] ?? value).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

function isValidResendWebhookSigningSecret(value: string | undefined): boolean {
  const encoded = value?.trim().match(/^whsec_([A-Za-z0-9+/]+={0,2})$/)?.[1];
  if (!encoded) return false;
  const decoded = Buffer.from(encoded, "base64");
  return decoded.byteLength >= 24
    && decoded.byteLength <= 64
    && decoded.toString("base64").replace(/=+$/, "") === encoded.replace(/=+$/, "");
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  RESTORE_REHEARSAL_MODE: booleanFromEnv.default(false),
  RESTORE_REHEARSAL_PHASE: z.enum(["bootstrap", "active"]).optional(),
  RESTORE_REHEARSAL_BACKUP_ID: optionalStringFromEnv,
  RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256: optionalSha256FromEnv,
  RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256: optionalSha256FromEnv,
  RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID: optionalStringFromEnv,
  RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID: optionalStringFromEnv,
  RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID: optionalStringFromEnv,
  RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL: optionalHttpUrlFromEnv,
  RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID: optionalStringFromEnv,
  RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL: optionalHttpUrlFromEnv,
  RESTORE_REHEARSAL_BACKUP_SUPABASE_URL: optionalHttpUrlFromEnv,
  RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID: optionalStringFromEnv,
  RESTORE_REHEARSAL_REDIS_SERVICE_ID: optionalStringFromEnv,
  RESTORE_REHEARSAL_REDIS_SENTINEL: optionalStringFromEnv,
  RESTORE_REHEARSAL_ACCESS_USERNAME: optionalStringFromEnv,
  RESTORE_REHEARSAL_ACCESS_PASSWORD: optionalStringFromEnv,
  TARGET_BEER: z.enum(["guinness", "carlton_draft", "stone_and_wood", "happy_hour"]).default("guinness"),
  HOST: z.preprocess((value) => {
    const trimmed = sanitizeEnvString(value);
    if (typeof trimmed !== "string") {
      return trimmed;
    }

    return trimmed.length === 0 ? undefined : trimmed;
  }, z.string().min(1).optional()),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.preprocess(sanitizeEnvString, z.string().url()),
  DATABASE_URL: optionalStringFromEnv,
  DATABASE_MAINTENANCE_URL: optionalStringFromEnv,
  PINTPATH_POSTGRES_ROOT_CA_PEM: optionalPostgresRootCaPemFromEnv,
  PINTPATH_POSTGRES_ROOT_CA_DER_SHA256: optionalSha256FromEnv,
  PINTPATH_IDENTITY_REGISTRY_PHASE: z.enum(["staging-bootstrap", "complete"]).default("complete"),
  PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID: optionalStringFromEnv,
  PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID: optionalStringFromEnv,
  PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID: optionalStringFromEnv,
  PINTPATH_DATABASE_RESOURCE_ID: optionalStringFromEnv,
  PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: optionalStringFromEnv,
  PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: optionalStringFromEnv,
  PINTPATH_EXPECTED_DATABASE_URL_SHA256: optionalSha256FromEnv,
  PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: optionalStringFromEnv,
  PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: optionalStringFromEnv,
  PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: optionalSha256FromEnv,
  DATABASE_PATH: z.preprocess(sanitizeEnvString, z.string()).default("./data/pint-path.sqlite"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(4).default(1),
  SUPABASE_URL: optionalHttpUrlFromEnv,
  SUPABASE_ANON_KEY: optionalStringFromEnv,
  SUPABASE_SERVICE_ROLE_KEY: optionalStringFromEnv,
  OFFSITE_BACKUP_SUPABASE_URL: optionalHttpUrlFromEnv,
  OFFSITE_BACKUP_SERVICE_ROLE_KEY: optionalStringFromEnv,
  SUPABASE_OAUTH_PROVIDERS: z.preprocess(sanitizeEnvString, z.string()).default("google"),
  SUPABASE_MENU_CAPTURE_TABLE: optionalStringFromEnv.default("venue_menu_captures"),
  ADMIN_EMAILS: optionalStringFromEnv,
  GOOGLE_MAPS_API_KEY: optionalStringFromEnv,
  GOOGLE_MAPS_MAP_ID: optionalStringFromEnv,
  GOOGLE_PLACES_API_KEY: optionalStringFromEnv,
  OPENAI_API_KEY: optionalStringFromEnv,
  OPENAI_MENU_OCR_MODEL: menuOcrModelFromEnv.default("gpt-5.6-sol"),
  OPENAI_MENU_OCR_FALLBACK_MODEL: menuOcrModelFromEnv.default("gpt-4.1"),
  OPENAI_MENU_OCR_REVIEW_PASS: booleanFromEnv.default(true),
  OPENAI_MENU_OCR_COST_BOUND_MODE: exactBooleanFromEnv.default(false),
  CONTRIBUTOR_UNLOCK_POINTS: z.coerce.number().int().min(1).default(15),
  CONTRIBUTOR_UNLOCK_DAYS: z.coerce.number().int().min(1).default(30),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  ADMIN_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(7).default(1),
  REQUIRE_ADMIN_MFA_IN_PRODUCTION: booleanFromEnv.default(true),
  ADMIN_MFA_MAX_AGE_MINUTES: z.coerce.number().int().min(5).max(1440).default(720),
  REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: booleanFromEnv.default(true),
  ANALYTICS_MIN_BUCKET_SIZE: z.coerce.number().int().min(1).max(100).default(5),
  REPORT_TIMEZONE: timeZoneFromEnv.default("Australia/Melbourne"),
  REPORT_EMAIL_MODE: z.enum(["disabled", "mock", "resend"]).default("disabled"),
  RESEND_API_KEY: optionalStringFromEnv,
  REPORT_EMAIL_FROM: optionalStringFromEnv,
  REPORT_EMAIL_REPLY_TO: optionalStringFromEnv,
  REPORT_DELIVERY_SCHEDULE_ENABLED: booleanFromEnv.default(false),
  REPORT_DELIVERY_DAY: z.coerce.number().int().min(1).max(28).default(2),
  REPORT_DELIVERY_HOUR: z.coerce.number().int().min(0).max(23).default(9),
  REPORT_DELIVERY_CHECK_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  ACCOUNT_DELETION_NOTICE_MODE: z.enum(["disabled", "mock", "resend"]).default("disabled"),
  RESEND_TRANSACTIONAL_API_KEY: optionalStringFromEnv,
  ACCOUNT_DELETION_NOTICE_FROM: optionalStringFromEnv,
  ACCOUNT_DELETION_NOTICE_REPLY_TO: optionalStringFromEnv,
  RESEND_WEBHOOK_SIGNING_SECRET: optionalStringFromEnv,
  ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID: optionalStringFromEnv,
  ACCOUNT_DELETION_NOTICE_KEYRING_JSON: optionalStringFromEnv,
  ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(60).default(5),
  ACCOUNT_DELETION_REHEARSAL_ENABLED: booleanFromEnv.default(false),
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID: optionalStringFromEnv,
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID: optionalStringFromEnv,
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID: optionalStringFromEnv,
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL: optionalHttpUrlFromEnv,
  ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL: optionalHttpUrlFromEnv,
  ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT: optionalPositiveIntegerFromEnv,
  REDIS_URL: optionalStringFromEnv,
  PINTPATH_REDIS_RESOURCE_ID: optionalStringFromEnv,
  PINTPATH_EXPECTED_REDIS_RESOURCE_ID: optionalStringFromEnv,
  PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: optionalStringFromEnv,
  PINTPATH_EXPECTED_REDIS_URL_SHA256: optionalSha256FromEnv,
  PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: optionalStringFromEnv,
  PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: optionalStringFromEnv,
  PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256: optionalSha256FromEnv,
  REDIS_KEY_NAMESPACE: optionalStringFromEnv,
  REQUIRE_REDIS_RATE_LIMITING: booleanFromEnv.default(false),
  ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: booleanFromEnv.default(false),
  DEMO_BILLING_MODE: demoBillingModeFromEnv,
  ALLOW_DEMO_BILLING_IN_PRODUCTION: booleanFromEnv.default(false),
  COMMERCIAL_LAUNCH_ENABLED: booleanFromEnv.default(false),
  CONSUMER_PAID_ENROLLMENT_ENABLED: booleanFromEnv.default(false),
  ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: booleanFromEnv.default(false),
  SOURCE_EVIDENCE_STORAGE_DIR: z.preprocess(sanitizeEnvString, z.string()).default("./data/source-evidence"),
  SOURCE_EVIDENCE_SIGNING_SECRET: optionalStringFromEnv,
  SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  SOURCE_EVIDENCE_RETENTION_DAYS: z.coerce.number().int().min(7).max(730).default(90),
  OFFSITE_BACKUP_BUCKET: z.preprocess(sanitizeEnvString, z.string()).default("pintpath-backups"),
  OFFSITE_BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(1).max(24).default(24),
  OFFSITE_BACKUP_RETENTION_DAYS: z.coerce.number().int().min(7).max(30).default(30),
  POS_WEBHOOK_SIGNING_SECRET: optionalStringFromEnv,
  FIELD_TEST_MODE: booleanFromEnv.default(false),
  PINT_POINTS_REWARDS_ENABLED: booleanFromEnv.default(false),
  ALCOHOL_GAMIFICATION_ENABLED: booleanFromEnv.default(false),
  ALCOHOL_PROMOTION_APPROVAL_REFERENCE: optionalStringFromEnv,
  STRIPE_SECRET_KEY: optionalStringFromEnv,
  STRIPE_WEBHOOK_SECRET: optionalStringFromEnv,
  STRIPE_PRICE_MONTHLY: optionalStringFromEnv,
  STRIPE_PRICE_YEARLY: optionalStringFromEnv,
  STRIPE_PRO_PRICE_ID: optionalStringFromEnv,
  VENUE_PRO_TRIAL_DAYS: z.coerce.number().int().refine(
    (value) => value === 0 || value === 30 || value === 60,
    "Use 0, 30, or 60 days.",
  ).default(0),
  VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD: booleanFromEnv.default(false),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  throw new Error(`Invalid environment configuration: ${JSON.stringify(parsedEnv.error.flatten(), null, 2)}`);
}

const railwayEnvironmentName = process.env.RAILWAY_ENVIRONMENT_NAME?.trim().toLowerCase();
if (
  (railwayEnvironmentName === "production" ||
    railwayEnvironmentName === "staging") &&
  parsedEnv.data.NODE_ENV !== "production"
) {
  throw new Error(
    "Hosted Railway production and staging application runtimes require NODE_ENV=production; refusing a development-mode persistence fallback.",
  );
}
const canonicalProductionRuntime = isCanonicalProductionRuntime({
  nodeEnv: parsedEnv.data.NODE_ENV,
  railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
});
const postgresApplicationRuntime =
  parsedEnv.data.NODE_ENV === "production" &&
  !parsedEnv.data.RESTORE_REHEARSAL_MODE;

function assertDedicatedMaintenanceConnection(
  applicationUrl: string | undefined,
  maintenanceUrl: string | undefined,
): void {
  assertTlsPostgresUrl(applicationUrl, "DATABASE_URL");
  assertTlsPostgresUrl(maintenanceUrl, "DATABASE_MAINTENANCE_URL");
  const application = new URL(applicationUrl!);
  const maintenance = new URL(maintenanceUrl!);
  if (application.port !== "5432" || maintenance.port !== "5432") {
    throw new Error(
      "DATABASE_URL and DATABASE_MAINTENANCE_URL must use the explicit direct/session Postgres port 5432; transaction pooling cannot preserve the pinned effective role.",
    );
  }
  try {
    parsePostgresRailwayStockLocalhostCaUrl(applicationUrl!);
  } catch {
    throw new Error(
      "DATABASE_URL must be the exact lower-case Railway private :5432 URL with only sslmode=verify-full.",
    );
  }
  try {
    parsePostgresRailwayStockLocalhostCaUrl(maintenanceUrl!);
  } catch {
    throw new Error(
      "DATABASE_MAINTENANCE_URL must be the exact lower-case Railway private :5432 URL with only sslmode=verify-full.",
    );
  }
  const sameDatabase =
    application.protocol === maintenance.protocol &&
    application.hostname.toLowerCase() === maintenance.hostname.toLowerCase() &&
    application.port === maintenance.port &&
    application.pathname === maintenance.pathname;
  if (!sameDatabase) {
    throw new Error(
      "DATABASE_MAINTENANCE_URL must target the same pinned Postgres host, port, and database as DATABASE_URL.",
    );
  }
  if (
    !application.username ||
    !maintenance.username ||
    decodeURIComponent(application.username) === decodeURIComponent(maintenance.username)
  ) {
    throw new Error(
      "DATABASE_MAINTENANCE_URL must use a dedicated maintenance login distinct from the web runtime login.",
    );
  }
}

if (canonicalProductionRuntime) {
  resolveExactOperationalOffsiteBackupBucket(process.env.OFFSITE_BACKUP_BUCKET);
}
const permanentStagingApplicationRuntime =
  postgresApplicationRuntime && railwayEnvironmentName === "staging";
const stagingIdentityBootstrap =
  parsedEnv.data.PINTPATH_IDENTITY_REGISTRY_PHASE === "staging-bootstrap";

if (parsedEnv.data.OPENAI_MENU_OCR_COST_BOUND_MODE) {
  if (
    !permanentStagingApplicationRuntime
    || parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_ENABLED
    || stagingIdentityBootstrap
  ) {
    throw new Error(
      "OPENAI_MENU_OCR_COST_BOUND_MODE=true is permitted only in complete ordinary permanent staging.",
    );
  }
  if (
    parsedEnv.data.OPENAI_MENU_OCR_MODEL !== OPENAI_MENU_OCR_COST_BOUND_MODEL
    || parsedEnv.data.OPENAI_MENU_OCR_FALLBACK_MODEL !== OPENAI_MENU_OCR_COST_BOUND_MODEL
  ) {
    throw new Error(
      `Cost-bound menu OCR requires both model variables to equal ${OPENAI_MENU_OCR_COST_BOUND_MODEL}.`,
    );
  }
}

if (
  stagingIdentityBootstrap
  && (
    !permanentStagingApplicationRuntime
    || parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_ENABLED
  )
) {
  throw new Error(
    "PINTPATH_IDENTITY_REGISTRY_PHASE=staging-bootstrap is allowed only in ordinary permanent staging; production, restore, and account-deletion rehearsal require the complete cross-environment identity registry.",
  );
}

assertPublicSupabaseKeySafe({
  parsedValue: parsedEnv.data.SUPABASE_ANON_KEY,
  rawValue: process.env.SUPABASE_ANON_KEY,
});

if (parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_ENABLED) {
  if (
    parsedEnv.data.NODE_ENV !== "production"
    || railwayEnvironmentName !== "staging"
    || parsedEnv.data.RESTORE_REHEARSAL_MODE
  ) {
    throw new Error(
      "ACCOUNT_DELETION_REHEARSAL_ENABLED=true is permitted only in the isolated Railway staging environment outside restore mode.",
    );
  }
  if (parsedEnv.data.ACCOUNT_DELETION_NOTICE_MODE !== "resend") {
    throw new Error("Account deletion rehearsal requires ACCOUNT_DELETION_NOTICE_MODE=resend.");
  }

  const accountDeletionRailwayPins = [
    ["ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID", parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID],
    ["ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID", parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID],
    ["ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID", parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID],
  ] as const;
  const missingAccountDeletionRailwayPins = accountDeletionRailwayPins
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missingAccountDeletionRailwayPins.length > 0) {
    throw new Error(
      `Account deletion rehearsal requires reviewed permanent-staging Railway identity pins: ${missingAccountDeletionRailwayPins.join(", ")}.`,
    );
  }
  const mismatchedAccountDeletionRailwayPins = [
    process.env.RAILWAY_PROJECT_ID?.trim() === parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID
      ? null
      : "RAILWAY_PROJECT_ID",
    process.env.RAILWAY_ENVIRONMENT_ID?.trim() === parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID
      ? null
      : "RAILWAY_ENVIRONMENT_ID",
    process.env.RAILWAY_SERVICE_ID?.trim() === parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID
      ? null
      : "RAILWAY_SERVICE_ID",
  ].filter((name): name is string => name !== null);
  if (mismatchedAccountDeletionRailwayPins.length > 0) {
    throw new Error(
      `Account deletion rehearsal runtime does not match the reviewed permanent-staging Railway pins: ${mismatchedAccountDeletionRailwayPins.join(", ")}.`,
    );
  }
  assertPermanentStagingRailwayIdentity({
    expectedProjectId: parsedEnv.data.PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID,
    expectedEnvironmentId: parsedEnv.data.PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID,
    expectedServiceId: parsedEnv.data.PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID,
  });
  if (
    !process.env.RAILWAY_REPLICA_ID?.trim()
    || (parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT ?? 0) < 2
  ) {
    throw new Error(
      "Account deletion rehearsal requires RAILWAY_REPLICA_ID and ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT>=2.",
    );
  }

  const railwayPublicDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim().toLowerCase();
  const publicBaseUrl = new URL(parsedEnv.data.PUBLIC_BASE_URL);
  if (
    !railwayPublicDomain
    || publicBaseUrl.origin.toLowerCase() !== `https://${railwayPublicDomain}`
    || publicBaseUrl.pathname !== "/"
    || publicBaseUrl.search
    || publicBaseUrl.hash
    || publicBaseUrl.username
    || publicBaseUrl.password
    || ["pintpath.au", "www.pintpath.au", "pintpath.com.au", "www.pintpath.com.au"]
      .includes(publicBaseUrl.hostname.toLowerCase())
  ) {
    throw new Error(
      "Account deletion rehearsal PUBLIC_BASE_URL must be the exact isolated staging HTTPS origin from RAILWAY_PUBLIC_DOMAIN.",
    );
  }

  const configuredDatabasePath = sanitizeEnvString(process.env.DATABASE_PATH);
  if (typeof configuredDatabasePath === "string" && configuredDatabasePath.length > 0) {
    throw new Error(
      "Account deletion rehearsal must not configure DATABASE_PATH; authoritative rehearsal state must use shared Postgres through DATABASE_URL.",
    );
  }
  assertTlsPostgresUrl(parsedEnv.data.DATABASE_URL, "DATABASE_URL");
  assertPinnedConnectionIdentity({
    connectionUrl: parsedEnv.data.DATABASE_URL,
    expectedDigest: parsedEnv.data.PINTPATH_EXPECTED_DATABASE_URL_SHA256,
    forbiddenDigests: parsedEnv.data.PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S,
    label: "database",
  });
  assertPinnedResourceIdentity({
    actual: parsedEnv.data.PINTPATH_DATABASE_RESOURCE_ID,
    expected: parsedEnv.data.PINTPATH_EXPECTED_DATABASE_RESOURCE_ID,
    forbidden: parsedEnv.data.PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS,
    label: "database",
  });
  assertRailwayServiceInstanceIdentity(
    parsedEnv.data.PINTPATH_DATABASE_RESOURCE_ID,
    process.env.RAILWAY_ENVIRONMENT_ID?.trim(),
    "PINTPATH_DATABASE_RESOURCE_ID",
  );

  if (!parsedEnv.data.SUPABASE_URL || !parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL) {
    throw new Error(
      "Account deletion rehearsal requires SUPABASE_URL and ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL for the reviewed permanent-staging project.",
    );
  }
  if (!parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL) {
    throw new Error(
      "Account deletion rehearsal requires ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL as a comparison-only production identity.",
    );
  }
  const accountDeletionSupabaseRef = canonicalSupabaseProjectRef(parsedEnv.data.SUPABASE_URL, "SUPABASE_URL");
  const expectedAccountDeletionSupabaseRef = canonicalSupabaseProjectRef(
    parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL,
    "ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL",
  );
  const productionAccountDeletionSupabaseRef = canonicalSupabaseProjectRef(
    parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL,
    "ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL",
  );
  if (accountDeletionSupabaseRef !== expectedAccountDeletionSupabaseRef) {
    throw new Error("Account deletion rehearsal SUPABASE_URL does not match the reviewed permanent-staging Supabase pin.");
  }
  if (accountDeletionSupabaseRef === productionAccountDeletionSupabaseRef) {
    throw new Error("Account deletion rehearsal Supabase must be distinct from the comparison-only production project.");
  }

  const prohibitedBackupCredentials = [
    ["OFFSITE_BACKUP_SUPABASE_URL", parsedEnv.data.OFFSITE_BACKUP_SUPABASE_URL],
    ["OFFSITE_BACKUP_SERVICE_ROLE_KEY", parsedEnv.data.OFFSITE_BACKUP_SERVICE_ROLE_KEY],
  ].filter(([, value]) => value !== undefined);
  if (prohibitedBackupCredentials.length > 0) {
    throw new Error(
      `Account deletion rehearsal prohibits off-site backup credentials: ${prohibitedBackupCredentials
        .map(([name]) => name)
        .join(", ")}.`,
    );
  }
  if (!parsedEnv.data.REDIS_URL || !parsedEnv.data.REQUIRE_REDIS_RATE_LIMITING) {
    throw new Error(
      "Account deletion rehearsal requires its dedicated shared REDIS_URL and REQUIRE_REDIS_RATE_LIMITING=true.",
    );
  }
  assertPinnedConnectionIdentity({
    connectionUrl: parsedEnv.data.REDIS_URL,
    expectedDigest: parsedEnv.data.PINTPATH_EXPECTED_REDIS_URL_SHA256,
    forbiddenDigests: parsedEnv.data.PINTPATH_FORBIDDEN_REDIS_URL_SHA256S,
    label: "redis",
  });
  assertPinnedResourceIdentity({
    actual: parsedEnv.data.PINTPATH_REDIS_RESOURCE_ID,
    expected: parsedEnv.data.PINTPATH_EXPECTED_REDIS_RESOURCE_ID,
    forbidden: parsedEnv.data.PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS,
    label: "redis",
  });
  assertRailwayServiceInstanceIdentity(
    parsedEnv.data.PINTPATH_REDIS_RESOURCE_ID,
    process.env.RAILWAY_ENVIRONMENT_ID?.trim(),
    "PINTPATH_REDIS_RESOURCE_ID",
  );
  assertPermanentStagingSelfPins({
    databaseExpectedDigest: parsedEnv.data.PINTPATH_EXPECTED_DATABASE_URL_SHA256,
    databaseExpectedResource: parsedEnv.data.PINTPATH_EXPECTED_DATABASE_RESOURCE_ID,
    databaseStagingDigest: parsedEnv.data.PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256,
    databaseStagingResource: parsedEnv.data.PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID,
    redisExpectedDigest: parsedEnv.data.PINTPATH_EXPECTED_REDIS_URL_SHA256,
    redisExpectedResource: parsedEnv.data.PINTPATH_EXPECTED_REDIS_RESOURCE_ID,
    redisStagingDigest: parsedEnv.data.PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256,
    redisStagingResource: parsedEnv.data.PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID,
  });
  if (parsedEnv.data.ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION) {
    throw new Error(
      "Account deletion rehearsal requires ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false so every replica fails closed through shared Redis.",
    );
  }

  const unsafeAccountDeletionFeatureConfiguration = [
    parsedEnv.data.COMMERCIAL_LAUNCH_ENABLED ? "COMMERCIAL_LAUNCH_ENABLED" : null,
    parsedEnv.data.CONSUMER_PAID_ENROLLMENT_ENABLED ? "CONSUMER_PAID_ENROLLMENT_ENABLED" : null,
    parsedEnv.data.DEMO_BILLING_MODE ? "DEMO_BILLING_MODE" : null,
    parsedEnv.data.PINT_POINTS_REWARDS_ENABLED ? "PINT_POINTS_REWARDS_ENABLED" : null,
    parsedEnv.data.ALCOHOL_GAMIFICATION_ENABLED ? "ALCOHOL_GAMIFICATION_ENABLED" : null,
    parsedEnv.data.REPORT_EMAIL_MODE !== "disabled" ? "REPORT_EMAIL_MODE" : null,
    parsedEnv.data.REPORT_DELIVERY_SCHEDULE_ENABLED ? "REPORT_DELIVERY_SCHEDULE_ENABLED" : null,
    parsedEnv.data.VENUE_PRO_TRIAL_DAYS !== 0 ? "VENUE_PRO_TRIAL_DAYS" : null,
    parsedEnv.data.VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD ? "VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD" : null,
    parsedEnv.data.FIELD_TEST_MODE ? "FIELD_TEST_MODE" : null,
  ].filter((name): name is string => name !== null);
  if (unsafeAccountDeletionFeatureConfiguration.length > 0) {
    throw new Error(
      `Account deletion rehearsal requires the Free-only feature scope: ${unsafeAccountDeletionFeatureConfiguration.join(", ")}.`,
    );
  }
  assertHostedSupabaseKeyBoundary({
    mode: "account-deletion-rehearsal",
    primaryUrl: parsedEnv.data.SUPABASE_URL,
    rawPrimaryUrl: process.env.SUPABASE_URL,
    anonKey: parsedEnv.data.SUPABASE_ANON_KEY,
    rawAnonKey: process.env.SUPABASE_ANON_KEY,
    serviceKey: parsedEnv.data.SUPABASE_SERVICE_ROLE_KEY,
    rawServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    offsiteServiceKey: parsedEnv.data.OFFSITE_BACKUP_SERVICE_ROLE_KEY,
    rawOffsiteServiceKey: process.env.OFFSITE_BACKUP_SERVICE_ROLE_KEY,
    offsiteUrl: parsedEnv.data.OFFSITE_BACKUP_SUPABASE_URL,
    rawOffsiteUrl: process.env.OFFSITE_BACKUP_SUPABASE_URL,
    rawOffsiteBucket: process.env.OFFSITE_BACKUP_BUCKET,
  });
}

if (!parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_ENABLED) {
  const accountDeletionRehearsalMarkers = [
    ["ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID", parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID],
    ["ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID", parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID],
    ["ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID", parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID],
    ["ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL", parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL],
    ["ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL", parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL],
    ["ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT", parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT],
  ]
    .filter((entry) => entry[1] !== undefined)
    .map(([name]) => name as string);
  if (accountDeletionRehearsalMarkers.length > 0) {
    throw new Error(
      `Account-deletion rehearsal identity/configuration requires ACCOUNT_DELETION_REHEARSAL_ENABLED=true: ${accountDeletionRehearsalMarkers.join(", ")}.`,
    );
  }
}

const requireStrongSecret = (name: string, value: string | undefined) => {
  const normalized = value?.trim() ?? "";
  const documentedPlaceholder = /(?:replace[_ -]?with|change[_ -]?me|placeholder|your[_ -].*secret)/i.test(normalized);
  const repeatedCharacter = normalized.length > 0 && new Set(normalized).size < 4;
  if (Buffer.byteLength(normalized, "utf8") < 32 || documentedPlaceholder || repeatedCharacter) {
    throw new Error(`${name} must be a unique high-entropy secret of at least 32 bytes in production.`);
  }
};

if (!parsedEnv.data.RESTORE_REHEARSAL_MODE) {
  const restoreMarkers: string[] = [
    ["RESTORE_REHEARSAL_PHASE", parsedEnv.data.RESTORE_REHEARSAL_PHASE],
    ["RESTORE_REHEARSAL_BACKUP_ID", parsedEnv.data.RESTORE_REHEARSAL_BACKUP_ID],
    ["RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256", parsedEnv.data.RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256],
    ["RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256", parsedEnv.data.RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256],
    ["RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID", parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID],
    ["RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID", parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID],
    ["RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID", parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID],
    ["RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL", parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL],
    ["RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID", parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID],
    ["RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL", parsedEnv.data.RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL],
    ["RESTORE_REHEARSAL_BACKUP_SUPABASE_URL", parsedEnv.data.RESTORE_REHEARSAL_BACKUP_SUPABASE_URL],
    ["RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID", parsedEnv.data.RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID],
    ["RESTORE_REHEARSAL_REDIS_SERVICE_ID", parsedEnv.data.RESTORE_REHEARSAL_REDIS_SERVICE_ID],
    ["RESTORE_REHEARSAL_REDIS_SENTINEL", parsedEnv.data.RESTORE_REHEARSAL_REDIS_SENTINEL],
    ["RESTORE_REHEARSAL_ACCESS_USERNAME", parsedEnv.data.RESTORE_REHEARSAL_ACCESS_USERNAME],
    ["RESTORE_REHEARSAL_ACCESS_PASSWORD", parsedEnv.data.RESTORE_REHEARSAL_ACCESS_PASSWORD],
  ]
    .filter((entry) => entry[1] !== undefined)
    .map((entry) => entry[0] as string);
  const normalizedDatabasePath = path.normalize(parsedEnv.data.DATABASE_PATH);
  const normalizedEvidencePath = path.normalize(parsedEnv.data.SOURCE_EVIDENCE_STORAGE_DIR);
  if (/^\/app\/data\/(?:bootstrap|(?:incoming|restore)-pint-path-)/.test(normalizedDatabasePath)) {
    restoreMarkers.push("DATABASE_PATH");
  }
  if (/^\/app\/data\/(?:bootstrap|(?:incoming|restore)-pint-path-)/.test(normalizedEvidencePath)) {
    restoreMarkers.push("SOURCE_EVIDENCE_STORAGE_DIR");
  }
  if (parsedEnv.data.REDIS_KEY_NAMESPACE?.startsWith("pint-path:restore:")) {
    restoreMarkers.push("REDIS_KEY_NAMESPACE");
  }
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() === "/app/data") {
    try {
      const restoreEntries = fs.readdirSync("/app/data", { withFileTypes: true })
        .filter((entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          /^(?:bootstrap|incoming-pint-path-|restore-pint-path-)/.test(entry.name),
        );
      if (restoreEntries.length > 0) restoreMarkers.push("RAILWAY_RESTORE_VOLUME_CONTENTS");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Unable to verify that the mounted Railway volume contains no restore runtime.");
      }
    }
  }

  if (restoreMarkers.length > 0) {
    throw new Error(
      `Restore-shaped configuration or volume contents require RESTORE_REHEARSAL_MODE=true: ${[...new Set(restoreMarkers)].join(", ")}.`,
    );
  }
}

if (postgresApplicationRuntime) {
  assertDedicatedMaintenanceConnection(
    parsedEnv.data.DATABASE_URL,
    parsedEnv.data.DATABASE_MAINTENANCE_URL,
  );
  if (
    !parsedEnv.data.PINTPATH_POSTGRES_ROOT_CA_PEM
    || !parsedEnv.data.PINTPATH_POSTGRES_ROOT_CA_DER_SHA256
  ) {
    throw new Error(
      "Hosted PostgreSQL requires PINTPATH_POSTGRES_ROOT_CA_PEM and its independently reviewed PINTPATH_POSTGRES_ROOT_CA_DER_SHA256 pin.",
    );
  }
  try {
    assertPostgresRailwayStockLocalhostRootCaPem(
      parsedEnv.data.PINTPATH_POSTGRES_ROOT_CA_PEM,
      parsedEnv.data.PINTPATH_POSTGRES_ROOT_CA_DER_SHA256,
    );
  } catch {
    throw new Error(
      "PINTPATH_POSTGRES_ROOT_CA_PEM must contain the one valid self-signed Railway CA matching PINTPATH_POSTGRES_ROOT_CA_DER_SHA256.",
    );
  }
}

if (
  permanentStagingApplicationRuntime
  && !parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_ENABLED
) {
  assertPermanentStagingRailwayIdentity({
    expectedProjectId: parsedEnv.data.PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID,
    expectedEnvironmentId: parsedEnv.data.PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID,
    expectedServiceId: parsedEnv.data.PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID,
  });
  assertHostedSupabaseKeyBoundary({
    mode: stagingIdentityBootstrap
      ? "permanent-staging-bootstrap"
      : "permanent-staging-complete",
    primaryUrl: parsedEnv.data.SUPABASE_URL,
    rawPrimaryUrl: process.env.SUPABASE_URL,
    anonKey: parsedEnv.data.SUPABASE_ANON_KEY,
    rawAnonKey: process.env.SUPABASE_ANON_KEY,
    serviceKey: parsedEnv.data.SUPABASE_SERVICE_ROLE_KEY,
    rawServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    offsiteServiceKey: parsedEnv.data.OFFSITE_BACKUP_SERVICE_ROLE_KEY,
    rawOffsiteServiceKey: process.env.OFFSITE_BACKUP_SERVICE_ROLE_KEY,
    offsiteUrl: parsedEnv.data.OFFSITE_BACKUP_SUPABASE_URL,
    rawOffsiteUrl: process.env.OFFSITE_BACKUP_SUPABASE_URL,
    rawOffsiteBucket: process.env.OFFSITE_BACKUP_BUCKET,
  });

  const configuredDatabasePath = sanitizeEnvString(process.env.DATABASE_PATH);
  if (typeof configuredDatabasePath === "string" && configuredDatabasePath.length > 0) {
    throw new Error(
      "Permanent staging must not configure DATABASE_PATH; its authoritative runtime uses only its reviewed PostgreSQL service instance.",
    );
  }
  assertTlsPostgresUrl(parsedEnv.data.DATABASE_URL, "DATABASE_URL");
  if (
    !parsedEnv.data.REDIS_URL
    || !parsedEnv.data.REQUIRE_REDIS_RATE_LIMITING
    || parsedEnv.data.ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION
  ) {
    throw new Error(
      "Permanent staging requires shared Redis, REQUIRE_REDIS_RATE_LIMITING=true, and ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false.",
    );
  }

  if (stagingIdentityBootstrap) {
    assertForbiddenIdentityPinsAbsent({
      databaseDigests: parsedEnv.data.PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S,
      databaseResources: parsedEnv.data.PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS,
      redisDigests: parsedEnv.data.PINTPATH_FORBIDDEN_REDIS_URL_SHA256S,
      redisResources: parsedEnv.data.PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS,
    });
    const unsafeBootstrapFeatures = [
      parsedEnv.data.COMMERCIAL_LAUNCH_ENABLED ? "COMMERCIAL_LAUNCH_ENABLED" : null,
      parsedEnv.data.CONSUMER_PAID_ENROLLMENT_ENABLED ? "CONSUMER_PAID_ENROLLMENT_ENABLED" : null,
      parsedEnv.data.DEMO_BILLING_MODE ? "DEMO_BILLING_MODE" : null,
      parsedEnv.data.PINT_POINTS_REWARDS_ENABLED ? "PINT_POINTS_REWARDS_ENABLED" : null,
      parsedEnv.data.ALCOHOL_GAMIFICATION_ENABLED ? "ALCOHOL_GAMIFICATION_ENABLED" : null,
      parsedEnv.data.REPORT_EMAIL_MODE !== "disabled" ? "REPORT_EMAIL_MODE" : null,
      parsedEnv.data.REPORT_DELIVERY_SCHEDULE_ENABLED ? "REPORT_DELIVERY_SCHEDULE_ENABLED" : null,
      parsedEnv.data.ACCOUNT_DELETION_NOTICE_MODE !== "disabled" ? "ACCOUNT_DELETION_NOTICE_MODE" : null,
      parsedEnv.data.FIELD_TEST_MODE ? "FIELD_TEST_MODE" : null,
      booleanFromEnv.safeParse(process.env.MENU_DISCOVERY_QUEUE_OCR).data ? "MENU_DISCOVERY_QUEUE_OCR" : null,
      booleanFromEnv.safeParse(process.env.ALLOW_MENU_DISCOVERY_QUEUE).data ? "ALLOW_MENU_DISCOVERY_QUEUE" : null,
      booleanFromEnv.safeParse(process.env.PINTPATH_REPORT_DELIVER).data ? "PINTPATH_REPORT_DELIVER" : null,
    ].filter((name): name is string => name !== null);
    if (unsafeBootstrapFeatures.length > 0) {
      throw new Error(
        `Permanent-staging identity bootstrap requires the inert Free scope with scheduled/provider writes disabled: ${unsafeBootstrapFeatures.join(", ")}.`,
      );
    }
  }

  const minimumForbidden = stagingIdentityBootstrap ? 0 : 2;
  assertPinnedConnectionIdentity({
    connectionUrl: parsedEnv.data.DATABASE_URL,
    expectedDigest: parsedEnv.data.PINTPATH_EXPECTED_DATABASE_URL_SHA256,
    forbiddenDigests: parsedEnv.data.PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S,
    label: "database",
    minimumForbidden,
  });
  assertPinnedResourceIdentity({
    actual: parsedEnv.data.PINTPATH_DATABASE_RESOURCE_ID,
    expected: parsedEnv.data.PINTPATH_EXPECTED_DATABASE_RESOURCE_ID,
    forbidden: parsedEnv.data.PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS,
    label: "database",
    minimumForbidden,
  });
  assertRailwayServiceInstanceIdentity(
    parsedEnv.data.PINTPATH_DATABASE_RESOURCE_ID,
    process.env.RAILWAY_ENVIRONMENT_ID?.trim(),
    "PINTPATH_DATABASE_RESOURCE_ID",
  );
  assertPinnedConnectionIdentity({
    connectionUrl: parsedEnv.data.REDIS_URL,
    expectedDigest: parsedEnv.data.PINTPATH_EXPECTED_REDIS_URL_SHA256,
    forbiddenDigests: parsedEnv.data.PINTPATH_FORBIDDEN_REDIS_URL_SHA256S,
    label: "redis",
    minimumForbidden,
  });
  assertPinnedResourceIdentity({
    actual: parsedEnv.data.PINTPATH_REDIS_RESOURCE_ID,
    expected: parsedEnv.data.PINTPATH_EXPECTED_REDIS_RESOURCE_ID,
    forbidden: parsedEnv.data.PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS,
    label: "redis",
    minimumForbidden,
  });
  assertRailwayServiceInstanceIdentity(
    parsedEnv.data.PINTPATH_REDIS_RESOURCE_ID,
    process.env.RAILWAY_ENVIRONMENT_ID?.trim(),
    "PINTPATH_REDIS_RESOURCE_ID",
  );
  assertPermanentStagingSelfPins({
    databaseExpectedDigest: parsedEnv.data.PINTPATH_EXPECTED_DATABASE_URL_SHA256,
    databaseExpectedResource: parsedEnv.data.PINTPATH_EXPECTED_DATABASE_RESOURCE_ID,
    databaseStagingDigest: parsedEnv.data.PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256,
    databaseStagingResource: parsedEnv.data.PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID,
    redisExpectedDigest: parsedEnv.data.PINTPATH_EXPECTED_REDIS_URL_SHA256,
    redisExpectedResource: parsedEnv.data.PINTPATH_EXPECTED_REDIS_RESOURCE_ID,
    redisStagingDigest: parsedEnv.data.PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256,
    redisStagingResource: parsedEnv.data.PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID,
  });
}

if (
  parsedEnv.data.NODE_ENV === "production" &&
  (parsedEnv.data.DEMO_BILLING_MODE || parsedEnv.data.ALLOW_DEMO_BILLING_IN_PRODUCTION)
) {
  throw new Error("Production requires DEMO_BILLING_MODE=false and ALLOW_DEMO_BILLING_IN_PRODUCTION=false.");
}

if (parsedEnv.data.NODE_ENV === "production" && parsedEnv.data.REPORT_EMAIL_MODE === "mock") {
  throw new Error("REPORT_EMAIL_MODE=mock is test-only and cannot be used in production.");
}

if (parsedEnv.data.NODE_ENV === "production" && parsedEnv.data.ACCOUNT_DELETION_NOTICE_MODE === "mock") {
  throw new Error("ACCOUNT_DELETION_NOTICE_MODE=mock is test-only and cannot be used in production.");
}

if (parsedEnv.data.ACCOUNT_DELETION_NOTICE_MODE !== "disabled") {
  if (!parsedEnv.data.ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID || !parsedEnv.data.ACCOUNT_DELETION_NOTICE_KEYRING_JSON) {
    throw new Error(
      "Account deletion notifications require ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID and ACCOUNT_DELETION_NOTICE_KEYRING_JSON.",
    );
  }
  parseAccountDeletionNotificationKeyring({
    activeKeyId: parsedEnv.data.ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID,
    keyringJson: parsedEnv.data.ACCOUNT_DELETION_NOTICE_KEYRING_JSON,
  });
}

if (parsedEnv.data.ACCOUNT_DELETION_NOTICE_MODE === "resend") {
  if (!parsedEnv.data.RESEND_TRANSACTIONAL_API_KEY) {
    throw new Error("RESEND_TRANSACTIONAL_API_KEY is required when ACCOUNT_DELETION_NOTICE_MODE=resend.");
  }
  if (!parsedEnv.data.ACCOUNT_DELETION_NOTICE_FROM || !isSafeConfiguredEmail(parsedEnv.data.ACCOUNT_DELETION_NOTICE_FROM)) {
    throw new Error("ACCOUNT_DELETION_NOTICE_FROM must be a configured sender when account deletion notices use Resend.");
  }
  if (!parsedEnv.data.ACCOUNT_DELETION_NOTICE_REPLY_TO || !isSafeConfiguredEmail(parsedEnv.data.ACCOUNT_DELETION_NOTICE_REPLY_TO)) {
    throw new Error("ACCOUNT_DELETION_NOTICE_REPLY_TO must be a monitored address when account deletion notices use Resend.");
  }
  if (!isValidResendWebhookSigningSecret(parsedEnv.data.RESEND_WEBHOOK_SIGNING_SECRET)) {
    throw new Error("RESEND_WEBHOOK_SIGNING_SECRET must be the valid whsec_ secret copied from the Resend webhook.");
  }
}

if (
  parsedEnv.data.ACCOUNT_DELETION_NOTICE_REPLY_TO &&
  !isSafeConfiguredEmail(parsedEnv.data.ACCOUNT_DELETION_NOTICE_REPLY_TO)
) {
  throw new Error("ACCOUNT_DELETION_NOTICE_REPLY_TO must be a valid email address when configured.");
}

if (parsedEnv.data.REPORT_EMAIL_MODE === "resend") {
  if (!parsedEnv.data.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is required when REPORT_EMAIL_MODE=resend.");
  }
  if (!parsedEnv.data.REPORT_EMAIL_FROM || !isSafeConfiguredEmail(parsedEnv.data.REPORT_EMAIL_FROM)) {
    throw new Error("REPORT_EMAIL_FROM must be a configured sender address when REPORT_EMAIL_MODE=resend.");
  }
  if (!parsedEnv.data.REPORT_EMAIL_REPLY_TO || !isSafeConfiguredEmail(parsedEnv.data.REPORT_EMAIL_REPLY_TO)) {
    throw new Error(
      "REPORT_EMAIL_REPLY_TO must be a monitored valid email address when REPORT_EMAIL_MODE=resend.",
    );
  }
}

if (parsedEnv.data.REPORT_EMAIL_REPLY_TO && !isSafeConfiguredEmail(parsedEnv.data.REPORT_EMAIL_REPLY_TO)) {
  throw new Error("REPORT_EMAIL_REPLY_TO must be a valid email address when configured.");
}

if (parsedEnv.data.REPORT_DELIVERY_SCHEDULE_ENABLED && parsedEnv.data.REPORT_EMAIL_MODE !== "resend") {
  throw new Error("REPORT_DELIVERY_SCHEDULE_ENABLED requires REPORT_EMAIL_MODE=resend.");
}

if (
  parsedEnv.data.NODE_ENV === "production" &&
  (parsedEnv.data.PINT_POINTS_REWARDS_ENABLED || parsedEnv.data.ALCOHOL_GAMIFICATION_ENABLED) &&
  !parsedEnv.data.ALCOHOL_PROMOTION_APPROVAL_REFERENCE
) {
  throw new Error(
    "Alcohol-linked rewards or gamification require ALCOHOL_PROMOTION_APPROVAL_REFERENCE in production. Keep both feature flags false until written Victorian liquor-promotion and App Store approval is recorded.",
  );
}

if (
  parsedEnv.data.NODE_ENV === "production" &&
  !parsedEnv.data.RESTORE_REHEARSAL_MODE &&
  !parsedEnv.data.COMMERCIAL_LAUNCH_ENABLED &&
  (
    parsedEnv.data.VENUE_PRO_TRIAL_DAYS !== 0 ||
    parsedEnv.data.VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD
  )
) {
  throw new Error(
    "Pricing is deferred: keep VENUE_PRO_TRIAL_DAYS=0 and VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD=false while COMMERCIAL_LAUNCH_ENABLED=false.",
  );
}

if (
  parsedEnv.data.NODE_ENV === "production" &&
  !parsedEnv.data.RESTORE_REHEARSAL_MODE &&
  parsedEnv.data.COMMERCIAL_LAUNCH_ENABLED &&
  (
    parsedEnv.data.VENUE_PRO_TRIAL_DAYS !== 60 ||
    parsedEnv.data.VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD
  )
) {
  throw new Error(
    "The future commercial launch contract currently requires a non-converting 60-day venue Pro offer: VENUE_PRO_TRIAL_DAYS=60 and VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD=false.",
  );
}

if (
  postgresApplicationRuntime &&
  (
    parsedEnv.data.COMMERCIAL_LAUNCH_ENABLED ||
    parsedEnv.data.CONSUMER_PAID_ENROLLMENT_ENABLED ||
    parsedEnv.data.PINT_POINTS_REWARDS_ENABLED ||
    parsedEnv.data.ALCOHOL_GAMIFICATION_ENABLED
  )
) {
  throw new Error(
    "Canonical PostgreSQL currently supports the frozen Free launch only. Keep COMMERCIAL_LAUNCH_ENABLED, CONSUMER_PAID_ENROLLMENT_ENABLED, PINT_POINTS_REWARDS_ENABLED, and ALCOHOL_GAMIFICATION_ENABLED false until their Postgres repositories and concurrency contracts are implemented.",
  );
}

if (parsedEnv.data.NODE_ENV === "production") {
  const publicBaseUrl = new URL(parsedEnv.data.PUBLIC_BASE_URL);
  if (publicBaseUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use https:// in production.");
  }

  requireStrongSecret("SOURCE_EVIDENCE_SIGNING_SECRET", parsedEnv.data.SOURCE_EVIDENCE_SIGNING_SECRET);
  if (!parsedEnv.data.RESTORE_REHEARSAL_MODE && parsedEnv.data.POS_WEBHOOK_SIGNING_SECRET) {
    requireStrongSecret("POS_WEBHOOK_SIGNING_SECRET", parsedEnv.data.POS_WEBHOOK_SIGNING_SECRET);
  }
  if (
    !parsedEnv.data.RESTORE_REHEARSAL_MODE &&
    (
      parsedEnv.data.COMMERCIAL_LAUNCH_ENABLED ||
      parsedEnv.data.CONSUMER_PAID_ENROLLMENT_ENABLED
    )
  ) {
    const missingStripe = [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PRICE_MONTHLY",
      "STRIPE_PRICE_YEARLY",
      "STRIPE_PRO_PRICE_ID",
    ].filter((name) => !parsedEnv.data[name as keyof typeof parsedEnv.data]);
    if (missingStripe.length) {
      throw new Error(`Enabled production paid enrollment requires: ${missingStripe.join(", ")}.`);
    }
  }
}

if (
  postgresApplicationRuntime &&
  !permanentStagingApplicationRuntime &&
  !parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_ENABLED
) {
  const configuredDatabasePath = sanitizeEnvString(process.env.DATABASE_PATH);
  if (typeof configuredDatabasePath === "string" && configuredDatabasePath.length > 0) {
    throw new Error(
      "Production application runtimes must not configure DATABASE_PATH; the web runtime uses only the reviewed PostgreSQL DATABASE_URL.",
    );
  }

  assertTlsPostgresUrl(parsedEnv.data.DATABASE_URL, "DATABASE_URL");
  assertPinnedConnectionIdentity({
    connectionUrl: parsedEnv.data.DATABASE_URL,
    expectedDigest: parsedEnv.data.PINTPATH_EXPECTED_DATABASE_URL_SHA256,
    forbiddenDigests: parsedEnv.data.PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S,
    label: "database",
  });
  assertPinnedResourceIdentity({
    actual: parsedEnv.data.PINTPATH_DATABASE_RESOURCE_ID,
    expected: parsedEnv.data.PINTPATH_EXPECTED_DATABASE_RESOURCE_ID,
    forbidden: parsedEnv.data.PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS,
    label: "database",
  });
  if (railwayEnvironmentName === "production") {
    assertRailwayServiceInstanceIdentity(
      parsedEnv.data.PINTPATH_DATABASE_RESOURCE_ID,
      process.env.RAILWAY_ENVIRONMENT_ID?.trim(),
      "PINTPATH_DATABASE_RESOURCE_ID",
    );
  }
}

if (canonicalProductionRuntime) {
  if (
    process.env.SUPABASE_URL !== canonicalProductionSupabaseOrigin
    || parsedEnv.data.SUPABASE_URL !== canonicalProductionSupabaseOrigin
  ) {
    throw new Error(
      "Canonical production requires SUPABASE_URL to be the exact reviewed HTTPS origin https://auth.pintpath.au; no configured value is emitted.",
    );
  }

  const publicBaseUrl = new URL(parsedEnv.data.PUBLIC_BASE_URL);
  if (!parsedEnv.data.REDIS_URL || !parsedEnv.data.REQUIRE_REDIS_RATE_LIMITING) {
    throw new Error("Canonical production requires shared REDIS_URL and REQUIRE_REDIS_RATE_LIMITING=true.");
  }
  if (parsedEnv.data.ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION) {
    throw new Error("Canonical production requires ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false.");
  }
  assertPinnedConnectionIdentity({
    connectionUrl: parsedEnv.data.REDIS_URL,
    expectedDigest: parsedEnv.data.PINTPATH_EXPECTED_REDIS_URL_SHA256,
    forbiddenDigests: parsedEnv.data.PINTPATH_FORBIDDEN_REDIS_URL_SHA256S,
    label: "redis",
  });
  assertPinnedResourceIdentity({
    actual: parsedEnv.data.PINTPATH_REDIS_RESOURCE_ID,
    expected: parsedEnv.data.PINTPATH_EXPECTED_REDIS_RESOURCE_ID,
    forbidden: parsedEnv.data.PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS,
    label: "redis",
  });
  if (railwayEnvironmentName === "production") {
    assertRailwayServiceInstanceIdentity(
      parsedEnv.data.PINTPATH_REDIS_RESOURCE_ID,
      process.env.RAILWAY_ENVIRONMENT_ID?.trim(),
      "PINTPATH_REDIS_RESOURCE_ID",
    );
  }
  assertPermanentStagingExcluded({
    databaseForbiddenDigests: parsedEnv.data.PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S,
    databaseForbiddenResources: parsedEnv.data.PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS,
    databaseStagingDigest: parsedEnv.data.PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256,
    databaseStagingResource: parsedEnv.data.PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID,
    redisForbiddenDigests: parsedEnv.data.PINTPATH_FORBIDDEN_REDIS_URL_SHA256S,
    redisForbiddenResources: parsedEnv.data.PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS,
    redisStagingDigest: parsedEnv.data.PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256,
    redisStagingResource: parsedEnv.data.PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID,
  });

  if (parsedEnv.data.ACCOUNT_DELETION_NOTICE_MODE !== "resend") {
    throw new Error(
      "Canonical production requires ACCOUNT_DELETION_NOTICE_MODE=resend so completed deletions receive a verified notice.",
    );
  }

  if (
    parsedEnv.data.SUPABASE_OAUTH_PROVIDERS
      .split(",")
      .some((provider) => provider.trim().toLowerCase() === "apple")
  ) {
    throw new Error(
      "Apple OAuth must remain disabled until Apple authorization-token revocation is implemented and tested.",
    );
  }

  if (
    process.env.PUBLIC_BASE_URL !== "https://pintpath.au"
    || parsedEnv.data.PUBLIC_BASE_URL !== "https://pintpath.au"
    || publicBaseUrl.protocol !== "https:"
    || publicBaseUrl.hostname !== "pintpath.au"
    || publicBaseUrl.port
    || publicBaseUrl.pathname !== "/"
    || publicBaseUrl.search
    || publicBaseUrl.hash
    || publicBaseUrl.username
    || publicBaseUrl.password
  ) {
    throw new Error("PUBLIC_BASE_URL must be exactly https://pintpath.au in production, with no whitespace, credentials, port, path, query, or fragment. Do not use Railway preview domains as the canonical public app URL.");
  }

  if (!parsedEnv.data.GOOGLE_MAPS_API_KEY) {
    throw new Error("GOOGLE_MAPS_API_KEY is required in production so the public map does not silently fail.");
  }

  if (!parsedEnv.data.GOOGLE_MAPS_MAP_ID) {
    throw new Error("GOOGLE_MAPS_MAP_ID is required in production for Google AdvancedMarkerElement/vector map styling.");
  }

  if (!parsedEnv.data.GOOGLE_PLACES_API_KEY) {
    throw new Error("GOOGLE_PLACES_API_KEY is required in production for venue search and identity verification.");
  }

  if (!parsedEnv.data.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required in production for menu evidence extraction.");
  }

  if (!parsedEnv.data.SUPABASE_URL || !parsedEnv.data.SUPABASE_ANON_KEY || !parsedEnv.data.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are required in production for authentication and durable source-evidence storage.");
  }

  const missingOffsiteBackupVariables = [
    ["OFFSITE_BACKUP_SUPABASE_URL", parsedEnv.data.OFFSITE_BACKUP_SUPABASE_URL],
    ["OFFSITE_BACKUP_SERVICE_ROLE_KEY", parsedEnv.data.OFFSITE_BACKUP_SERVICE_ROLE_KEY],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missingOffsiteBackupVariables.length > 0) {
    const variableLabel = missingOffsiteBackupVariables.length === 1 ? "variable" : "variables";
    const referenceLabel = missingOffsiteBackupVariables.length === 1 ? "it" : "them";
    throw new Error(
      `Production startup blocked: missing required private operational restore-copy environment ${variableLabel}: ${missingOffsiteBackupVariables.join(", ")}. ` +
      `Configure ${referenceLabel} in the production service environment and redeploy. ` +
      "OFFSITE_BACKUP_SUPABASE_URL must point to an origin different from SUPABASE_URL, and OFFSITE_BACKUP_SERVICE_ROLE_KEY must belong to that operational copy. This does not replace separately verified WORM disaster recovery.",
    );
  }
  assertCompatibleSupabaseServiceKey({
    name: "SUPABASE_SERVICE_ROLE_KEY",
    parsedValue: parsedEnv.data.SUPABASE_SERVICE_ROLE_KEY,
    rawValue: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  assertCompatibleSupabaseServiceKey({
    name: "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
    parsedValue: parsedEnv.data.OFFSITE_BACKUP_SERVICE_ROLE_KEY,
    rawValue: process.env.OFFSITE_BACKUP_SERVICE_ROLE_KEY,
  });

  if (
    parsedEnv.data.OFFSITE_BACKUP_SUPABASE_URL !== operationalOffsiteSupabaseOrigin
    || process.env.OFFSITE_BACKUP_SUPABASE_URL !== operationalOffsiteSupabaseOrigin
  ) {
    throw new Error(
      "Canonical production requires OFFSITE_BACKUP_SUPABASE_URL to be the exact reviewed operational-copy HTTPS origin; no configured value is emitted.",
    );
  }
  if (
    parsedEnv.data.SUPABASE_SERVICE_ROLE_KEY
    === parsedEnv.data.OFFSITE_BACKUP_SERVICE_ROLE_KEY
  ) {
    throw new Error(
      "Canonical production requires distinct primary and operational-copy Supabase service keys; no key value is emitted.",
    );
  }

  if (
    new URL(parsedEnv.data.SUPABASE_URL).origin.toLowerCase() ===
    new URL(parsedEnv.data.OFFSITE_BACKUP_SUPABASE_URL!).origin.toLowerCase()
  ) {
    throw new Error("OFFSITE_BACKUP_SUPABASE_URL must identify a distinct private operational restore-copy origin, not the production Supabase project. A distinct origin alone is not WORM disaster recovery.");
  }

}

if (parsedEnv.data.RESTORE_REHEARSAL_MODE) {
  if (parsedEnv.data.NODE_ENV !== "production" || railwayEnvironmentName !== "staging") {
    throw new Error(
      "RESTORE_REHEARSAL_MODE is allowed only with NODE_ENV=production in the Railway environment named exactly staging.",
    );
  }
  assertPermanentStagingExcluded({
    databaseForbiddenDigests: parsedEnv.data.PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S,
    databaseForbiddenResources: parsedEnv.data.PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS,
    databaseStagingDigest: parsedEnv.data.PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256,
    databaseStagingResource: parsedEnv.data.PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID,
    redisForbiddenDigests: parsedEnv.data.PINTPATH_FORBIDDEN_REDIS_URL_SHA256S,
    redisForbiddenResources: parsedEnv.data.PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS,
    redisStagingDigest: parsedEnv.data.PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256,
    redisStagingResource: parsedEnv.data.PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID,
  });

  const restoreRailwayPins = [
    ["RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID", parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID],
    ["RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID", parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID],
    ["RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID", parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID],
  ] as const;
  const missingRestoreRailwayPins = restoreRailwayPins
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missingRestoreRailwayPins.length > 0) {
    throw new Error(`Restore rehearsal requires reviewed Railway identity pins: ${missingRestoreRailwayPins.join(", ")}.`);
  }

  const railwayEnvironmentId = process.env.RAILWAY_ENVIRONMENT_ID?.trim();
  const mismatchedRestoreRailwayPins = [
    railwayEnvironmentId === parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID
      ? null
      : "RAILWAY_ENVIRONMENT_ID",
    process.env.RAILWAY_PROJECT_ID?.trim() === parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID
      ? null
      : "RAILWAY_PROJECT_ID",
    process.env.RAILWAY_SERVICE_ID?.trim() === parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID
      ? null
      : "RAILWAY_SERVICE_ID",
  ].filter((name): name is string => name !== null);
  if (mismatchedRestoreRailwayPins.length > 0) {
    throw new Error(
      `Restore rehearsal runtime does not match the reviewed disposable Railway pins: ${mismatchedRestoreRailwayPins.join(", ")}.`,
    );
  }
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() !== "/app/data") {
    throw new Error("Restore rehearsal requires RAILWAY_VOLUME_MOUNT_PATH=/app/data.");
  }
  if (!parsedEnv.data.RESTORE_REHEARSAL_PHASE) {
    throw new Error("Restore rehearsal requires RESTORE_REHEARSAL_PHASE=bootstrap or active.");
  }
  const backupId = parsedEnv.data.RESTORE_REHEARSAL_BACKUP_ID?.trim() ?? "";
  if (!/^pint-path-[A-Za-z0-9][A-Za-z0-9._-]{8,120}$/.test(backupId)) {
    throw new Error("RESTORE_REHEARSAL_BACKUP_ID must be the selected safe Pint Path backup ID.");
  }
  if (!parsedEnv.data.RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256) {
    throw new Error("RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256 is required to bind the restore to its verified source backup.");
  }
  if (!parsedEnv.data.RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256) {
    throw new Error("RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256 is required to anchor the post-rehearsal runtime copy.");
  }

  const railwayPublicDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim().toLowerCase();
  if (!railwayPublicDomain) {
    throw new Error("RESTORE_REHEARSAL_MODE requires Railway's RAILWAY_PUBLIC_DOMAIN system variable.");
  }
  const publicBaseUrl = new URL(parsedEnv.data.PUBLIC_BASE_URL);
  if (
    publicBaseUrl.protocol !== "https:" ||
    publicBaseUrl.origin.toLowerCase() !== `https://${railwayPublicDomain}` ||
    publicBaseUrl.pathname !== "/" ||
    publicBaseUrl.username ||
    publicBaseUrl.password
  ) {
    throw new Error(
      "Restore rehearsal PUBLIC_BASE_URL must be the exact HTTPS origin identified by RAILWAY_PUBLIC_DOMAIN.",
    );
  }
  if (["pintpath.au", "www.pintpath.au"].includes(publicBaseUrl.hostname.toLowerCase())) {
    throw new Error("Restore rehearsal PUBLIC_BASE_URL must never use a Pint Path production hostname.");
  }

  const databasePath = parsedEnv.data.DATABASE_PATH;
  const evidencePath = parsedEnv.data.SOURCE_EVIDENCE_STORAGE_DIR;
  const restoreRoot = path.dirname(databasePath);
  const expectedRestoreRoot = parsedEnv.data.RESTORE_REHEARSAL_PHASE === "bootstrap"
    ? "/app/data/bootstrap"
    : `/app/data/restore-${backupId}`;
  if (path.normalize(databasePath) !== path.join(expectedRestoreRoot, "pint-path.sqlite")) {
    throw new Error(
      parsedEnv.data.RESTORE_REHEARSAL_PHASE === "bootstrap"
        ? "Restore bootstrap DATABASE_PATH must be /app/data/bootstrap/pint-path.sqlite and is never opened."
        : "Active restore DATABASE_PATH must exactly match /app/data/restore-${RESTORE_REHEARSAL_BACKUP_ID}/pint-path.sqlite.",
    );
  }
  if (!path.isAbsolute(evidencePath) || path.normalize(evidencePath) !== path.join(restoreRoot, "source-evidence")) {
    throw new Error("Restore rehearsal SOURCE_EVIDENCE_STORAGE_DIR must be the source-evidence directory beside DATABASE_PATH.");
  }

  if (!parsedEnv.data.SUPABASE_URL || !parsedEnv.data.SUPABASE_ANON_KEY || !parsedEnv.data.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Restore rehearsal requires its own SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  if (
    !parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL ||
    !parsedEnv.data.RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL ||
    !parsedEnv.data.RESTORE_REHEARSAL_BACKUP_SUPABASE_URL
  ) {
    throw new Error(
      "Restore rehearsal requires reviewed restore, production, and operational-restore-copy Supabase URL pins so it can prove the disposable project is exact and distinct.",
    );
  }
  assertCompatibleSupabaseServiceKey({
    name: "SUPABASE_SERVICE_ROLE_KEY",
    parsedValue: parsedEnv.data.SUPABASE_SERVICE_ROLE_KEY,
    rawValue: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  const restoreSupabaseRef = canonicalSupabaseProjectRef(parsedEnv.data.SUPABASE_URL, "SUPABASE_URL");
  const expectedRestoreSupabaseRef = canonicalSupabaseProjectRef(
    parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL,
    "RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL",
  );
  const productionSupabaseRef = canonicalSupabaseProjectRef(
    parsedEnv.data.RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL,
    "RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL",
  );
  const backupSupabaseRef = canonicalSupabaseProjectRef(
    parsedEnv.data.RESTORE_REHEARSAL_BACKUP_SUPABASE_URL,
    "RESTORE_REHEARSAL_BACKUP_SUPABASE_URL",
  );
  if (
    restoreSupabaseRef !== expectedRestoreSupabaseRef ||
    new Set([restoreSupabaseRef, productionSupabaseRef, backupSupabaseRef]).size !== 3
  ) {
    throw new Error(
      "Restore rehearsal Supabase identities must match the reviewed disposable restore pin and remain distinct from production and the operational restore copy.",
    );
  }

  if (!parsedEnv.data.REDIS_URL || !parsedEnv.data.REQUIRE_REDIS_RATE_LIMITING) {
    throw new Error("Restore rehearsal requires its own REDIS_URL and REQUIRE_REDIS_RATE_LIMITING=true.");
  }
  assertCanonicalRestoreRedisUrl(parsedEnv.data.REDIS_URL);
  if (parsedEnv.data.RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID !== railwayEnvironmentId) {
    throw new Error("RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID must be a Railway reference to the current staging environment ID.");
  }
  if (
    !parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID
    || parsedEnv.data.RESTORE_REHEARSAL_REDIS_SERVICE_ID !== parsedEnv.data.RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID
  ) {
    throw new Error("RESTORE_REHEARSAL_REDIS_SERVICE_ID must match the reviewed disposable Redis service pin.");
  }
  const expectedRedisNamespace = `pint-path:restore:${railwayEnvironmentId}:${backupId}`;
  if (parsedEnv.data.REDIS_KEY_NAMESPACE !== expectedRedisNamespace) {
    throw new Error(`REDIS_KEY_NAMESPACE must exactly bind the staging environment and selected backup (${expectedRedisNamespace}).`);
  }
  requireStrongSecret("RESTORE_REHEARSAL_REDIS_SENTINEL", parsedEnv.data.RESTORE_REHEARSAL_REDIS_SENTINEL);
  if (!parsedEnv.data.GOOGLE_MAPS_API_KEY || !parsedEnv.data.GOOGLE_MAPS_MAP_ID) {
    throw new Error(
      "Restore rehearsal requires a staging-origin-restricted GOOGLE_MAPS_API_KEY and GOOGLE_MAPS_MAP_ID for visual map checks.",
    );
  }
  if (parsedEnv.data.SUPABASE_OAUTH_PROVIDERS.trim() !== "") {
    throw new Error("Restore rehearsal requires SUPABASE_OAUTH_PROVIDERS to be explicitly empty.");
  }
  if (
    parsedEnv.data.REPORT_EMAIL_MODE !== "disabled" ||
    parsedEnv.data.REPORT_DELIVERY_SCHEDULE_ENABLED ||
    parsedEnv.data.ACCOUNT_DELETION_NOTICE_MODE !== "disabled"
  ) {
    throw new Error("Restore rehearsal requires reports and all email delivery to remain disabled.");
  }
  if (parsedEnv.data.DEMO_BILLING_MODE || parsedEnv.data.ALLOW_DEMO_BILLING_IN_PRODUCTION) {
    throw new Error("Restore rehearsal requires billing to be fully disabled, not demo-enabled.");
  }
  if (parsedEnv.data.ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION) {
    throw new Error("Restore rehearsal cannot enable demo image storage in the production build.");
  }
  if (
    parsedEnv.data.FIELD_TEST_MODE ||
    !parsedEnv.data.REQUIRE_ADMIN_MFA_IN_PRODUCTION ||
    !parsedEnv.data.REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION
  ) {
    throw new Error(
      "Restore rehearsal requires field-test mode off, production admin MFA on, and verified accounts required.",
    );
  }

  const prohibitedConfiguredVariables = [
    ["OFFSITE_BACKUP_SUPABASE_URL", parsedEnv.data.OFFSITE_BACKUP_SUPABASE_URL],
    ["OFFSITE_BACKUP_SERVICE_ROLE_KEY", parsedEnv.data.OFFSITE_BACKUP_SERVICE_ROLE_KEY],
    ["RESEND_API_KEY", parsedEnv.data.RESEND_API_KEY],
    ["REPORT_EMAIL_FROM", parsedEnv.data.REPORT_EMAIL_FROM],
    ["REPORT_EMAIL_REPLY_TO", parsedEnv.data.REPORT_EMAIL_REPLY_TO],
    ["RESEND_TRANSACTIONAL_API_KEY", parsedEnv.data.RESEND_TRANSACTIONAL_API_KEY],
    ["ACCOUNT_DELETION_NOTICE_FROM", parsedEnv.data.ACCOUNT_DELETION_NOTICE_FROM],
    ["ACCOUNT_DELETION_NOTICE_REPLY_TO", parsedEnv.data.ACCOUNT_DELETION_NOTICE_REPLY_TO],
    ["RESEND_WEBHOOK_SIGNING_SECRET", parsedEnv.data.RESEND_WEBHOOK_SIGNING_SECRET],
    ["ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID", parsedEnv.data.ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID],
    ["ACCOUNT_DELETION_NOTICE_KEYRING_JSON", parsedEnv.data.ACCOUNT_DELETION_NOTICE_KEYRING_JSON],
    ["STRIPE_SECRET_KEY", parsedEnv.data.STRIPE_SECRET_KEY],
    ["STRIPE_WEBHOOK_SECRET", parsedEnv.data.STRIPE_WEBHOOK_SECRET],
    ["STRIPE_PRICE_MONTHLY", parsedEnv.data.STRIPE_PRICE_MONTHLY],
    ["STRIPE_PRICE_YEARLY", parsedEnv.data.STRIPE_PRICE_YEARLY],
    ["STRIPE_PRO_PRICE_ID", parsedEnv.data.STRIPE_PRO_PRICE_ID],
    ["OPENAI_API_KEY", parsedEnv.data.OPENAI_API_KEY],
    ["GOOGLE_PLACES_API_KEY", parsedEnv.data.GOOGLE_PLACES_API_KEY],
    ["POS_WEBHOOK_SIGNING_SECRET", parsedEnv.data.POS_WEBHOOK_SIGNING_SECRET],
    ["ALCOHOL_PROMOTION_APPROVAL_REFERENCE", parsedEnv.data.ALCOHOL_PROMOTION_APPROVAL_REFERENCE],
    ["ADMIN_EMAILS", parsedEnv.data.ADMIN_EMAILS],
    ["ADMIN_SHARED_SECRET", process.env.ADMIN_SHARED_SECRET],
    ["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY],
    ["ADMIN_BEARER_TOKEN", process.env.ADMIN_BEARER_TOKEN],
    ["PINTPATH_SMOKE_USER_TOKEN", process.env.PINTPATH_SMOKE_USER_TOKEN],
    ["PINTPATH_SMOKE_VENUE_TOKEN", process.env.PINTPATH_SMOKE_VENUE_TOKEN],
    ["PINTPATH_SMOKE_ADMIN_TOKEN", process.env.PINTPATH_SMOKE_ADMIN_TOKEN],
    ["PINTPATH_SMOKE_USER_EMAIL", process.env.PINTPATH_SMOKE_USER_EMAIL],
    ["PINTPATH_SMOKE_USER_PASSWORD", process.env.PINTPATH_SMOKE_USER_PASSWORD],
    ["PINTPATH_SMOKE_VENUE_EMAIL", process.env.PINTPATH_SMOKE_VENUE_EMAIL],
    ["PINTPATH_SMOKE_VENUE_PASSWORD", process.env.PINTPATH_SMOKE_VENUE_PASSWORD],
    ["PINTPATH_SMOKE_ADMIN_EMAIL", process.env.PINTPATH_SMOKE_ADMIN_EMAIL],
    ["PINTPATH_SMOKE_ADMIN_PASSWORD", process.env.PINTPATH_SMOKE_ADMIN_PASSWORD],
    ["PINTPATH_SMOKE_BASE_URL", process.env.PINTPATH_SMOKE_BASE_URL],
    ["MENU_DISCOVERY_ADMIN_BEARER", process.env.MENU_DISCOVERY_ADMIN_BEARER],
    ["MENU_DISCOVERY_ADMIN_BASE_URL", process.env.MENU_DISCOVERY_ADMIN_BASE_URL],
  ].filter(([, value]) => typeof value === "string" && value.trim().length > 0);
  if (prohibitedConfiguredVariables.length > 0) {
    throw new Error(
      `Restore rehearsal prohibits external-write credentials: ${prohibitedConfiguredVariables.map(([name]) => name).join(", ")}.`,
    );
  }

  const prohibitedEnabledFlags = [
    ["PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS", booleanFromEnv.safeParse(process.env.PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS).data],
    ["ALLOW_FAKE_SEED", booleanFromEnv.safeParse(process.env.ALLOW_FAKE_SEED).data],
    ["MENU_DISCOVERY_QUEUE_OCR", booleanFromEnv.safeParse(process.env.MENU_DISCOVERY_QUEUE_OCR).data],
    ["ALLOW_MENU_DISCOVERY_QUEUE", booleanFromEnv.safeParse(process.env.ALLOW_MENU_DISCOVERY_QUEUE).data],
    ["PINTPATH_REPORT_DELIVER", booleanFromEnv.safeParse(process.env.PINTPATH_REPORT_DELIVER).data],
    ["PINT_POINTS_REWARDS_ENABLED", parsedEnv.data.PINT_POINTS_REWARDS_ENABLED],
    ["ALCOHOL_GAMIFICATION_ENABLED", parsedEnv.data.ALCOHOL_GAMIFICATION_ENABLED],
    ["COMMERCIAL_LAUNCH_ENABLED", parsedEnv.data.COMMERCIAL_LAUNCH_ENABLED],
    ["CONSUMER_PAID_ENROLLMENT_ENABLED", parsedEnv.data.CONSUMER_PAID_ENROLLMENT_ENABLED],
  ].filter(([, enabled]) => enabled === true);
  if (prohibitedEnabledFlags.length > 0) {
    throw new Error(
      `Restore rehearsal prohibits write-enabling flags: ${prohibitedEnabledFlags.map(([name]) => name).join(", ")}.`,
    );
  }

  requireStrongSecret("SOURCE_EVIDENCE_SIGNING_SECRET", parsedEnv.data.SOURCE_EVIDENCE_SIGNING_SECRET);
  requireStrongSecret("RESTORE_REHEARSAL_ACCESS_PASSWORD", parsedEnv.data.RESTORE_REHEARSAL_ACCESS_PASSWORD);
  if (Buffer.byteLength(parsedEnv.data.RESTORE_REHEARSAL_ACCESS_PASSWORD ?? "", "utf8") > 512) {
    throw new Error("RESTORE_REHEARSAL_ACCESS_PASSWORD must be no more than 512 bytes.");
  }
  const accessUsername = parsedEnv.data.RESTORE_REHEARSAL_ACCESS_USERNAME?.trim() ?? "";
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(accessUsername)) {
    throw new Error(
      "RESTORE_REHEARSAL_ACCESS_USERNAME must be 3-64 characters using letters, numbers, dot, underscore, or hyphen.",
    );
  }
}

export const env = {
  ...parsedEnv.data,
  DATABASE_PATH: path.isAbsolute(parsedEnv.data.DATABASE_PATH)
    ? parsedEnv.data.DATABASE_PATH
    : path.resolve(process.cwd(), parsedEnv.data.DATABASE_PATH),
  SOURCE_EVIDENCE_STORAGE_DIR: path.isAbsolute(parsedEnv.data.SOURCE_EVIDENCE_STORAGE_DIR)
    ? parsedEnv.data.SOURCE_EVIDENCE_STORAGE_DIR
    : path.resolve(process.cwd(), parsedEnv.data.SOURCE_EVIDENCE_STORAGE_DIR),
};

export type Env = typeof env;

export function assertApplicationServerStartAllowed(
  identityRegistryPhase = env.PINTPATH_IDENTITY_REGISTRY_PHASE,
): void {
  if (identityRegistryPhase === "staging-bootstrap") {
    throw new Error(
      "Permanent-staging identity bootstrap is operator-only: run configuration and PostgreSQL runtime verification, then complete the cross-environment identity registry before starting the web server, routes, or workers.",
    );
  }
}
