import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

import { isCanonicalProductionRuntime } from "../lib/deployment-environment.js";
import { parseAccountDeletionNotificationKeyring } from "../lib/account-deletion-notification-worker.js";

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

const RESTORE_REHEARSAL_RAILWAY_ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const RESTORE_REHEARSAL_RAILWAY_PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const RESTORE_REHEARSAL_BEER_SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const RESTORE_REHEARSAL_REDIS_SERVICE_ID = "d6351cec-fe04-4a6f-8e05-1cc164ea1e73";
const RESTORE_REHEARSAL_PRODUCTION_SUPABASE_REF = "jxpubqlmqnnqwadmjgyk";
const RESTORE_REHEARSAL_BACKUP_SUPABASE_REF = "gjjffexmflwtnewtkkiy";
const RESTORE_REHEARSAL_SUPABASE_REF = "ibveugyfyzjptyvautlr";
const ACCOUNT_DELETION_REHEARSAL_RAILWAY_ENVIRONMENT_ID = RESTORE_REHEARSAL_RAILWAY_ENVIRONMENT_ID;
const ACCOUNT_DELETION_REHEARSAL_RAILWAY_PROJECT_ID = RESTORE_REHEARSAL_RAILWAY_PROJECT_ID;
const ACCOUNT_DELETION_REHEARSAL_BEER_SERVICE_ID = RESTORE_REHEARSAL_BEER_SERVICE_ID;
const ACCOUNT_DELETION_REHEARSAL_SUPABASE_REF = RESTORE_REHEARSAL_SUPABASE_REF;

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
  REDIS_URL: optionalStringFromEnv,
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
const canonicalProductionRuntime = isCanonicalProductionRuntime({
  nodeEnv: parsedEnv.data.NODE_ENV,
  railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
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
  if (
    process.env.RAILWAY_PROJECT_ID?.trim() !== ACCOUNT_DELETION_REHEARSAL_RAILWAY_PROJECT_ID
    || process.env.RAILWAY_ENVIRONMENT_ID?.trim() !== ACCOUNT_DELETION_REHEARSAL_RAILWAY_ENVIRONMENT_ID
    || process.env.RAILWAY_SERVICE_ID?.trim() !== ACCOUNT_DELETION_REHEARSAL_BEER_SERVICE_ID
  ) {
    throw new Error(
      "Account deletion rehearsal is bound to the immutable Pint Path staging Railway project, environment, and Beer service IDs.",
    );
  }
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() !== "/app/data") {
    throw new Error("Account deletion rehearsal requires the dedicated staging volume at RAILWAY_VOLUME_MOUNT_PATH=/app/data.");
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
  if (
    path.normalize(parsedEnv.data.DATABASE_PATH) !== "/app/data/pint-path.sqlite"
    || path.normalize(parsedEnv.data.SOURCE_EVIDENCE_STORAGE_DIR) !== "/app/data/source-evidence"
  ) {
    throw new Error(
      "Account deletion rehearsal must use only the dedicated staging SQLite and evidence paths under /app/data.",
    );
  }
  if (
    !parsedEnv.data.SUPABASE_URL
    || canonicalSupabaseProjectRef(parsedEnv.data.SUPABASE_URL, "SUPABASE_URL")
      !== ACCOUNT_DELETION_REHEARSAL_SUPABASE_REF
  ) {
    throw new Error("Account deletion rehearsal is bound to the dedicated non-production Supabase project.");
  }
  if (
    parsedEnv.data.STRIPE_SECRET_KEY
    && !/^(?:sk|rk)_test_/.test(parsedEnv.data.STRIPE_SECRET_KEY)
  ) {
    throw new Error("Account deletion rehearsal may use only a Stripe test-mode secret or no Stripe secret.");
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
  const prohibitedRedisVariables = [
    ["REDIS_URL", parsedEnv.data.REDIS_URL],
    ["REDIS_KEY_NAMESPACE", parsedEnv.data.REDIS_KEY_NAMESPACE],
    ["RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID", parsedEnv.data.RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID],
    ["RESTORE_REHEARSAL_REDIS_SERVICE_ID", parsedEnv.data.RESTORE_REHEARSAL_REDIS_SERVICE_ID],
    ["RESTORE_REHEARSAL_REDIS_SENTINEL", parsedEnv.data.RESTORE_REHEARSAL_REDIS_SENTINEL],
  ].filter(([, value]) => value !== undefined);
  if (prohibitedRedisVariables.length > 0 || parsedEnv.data.REQUIRE_REDIS_RATE_LIMITING) {
    throw new Error(
      "Account deletion rehearsal prohibits Redis configuration; remove all Redis references and keep REQUIRE_REDIS_RATE_LIMITING=false.",
    );
  }
  if (!parsedEnv.data.ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION) {
    throw new Error(
      "Account deletion rehearsal requires ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=true for its isolated single-instance staging proof.",
    );
  }
  if (
    parsedEnv.data.COMMERCIAL_LAUNCH_ENABLED
    || parsedEnv.data.CONSUMER_PAID_ENROLLMENT_ENABLED
    || parsedEnv.data.REPORT_EMAIL_MODE !== "disabled"
    || parsedEnv.data.REPORT_DELIVERY_SCHEDULE_ENABLED
  ) {
    throw new Error(
      "Account deletion rehearsal requires paid enrollment and report delivery to remain disabled.",
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
  if (
    !parsedEnv.data.ACCOUNT_DELETION_REHEARSAL_ENABLED
    && parsedEnv.data.SUPABASE_URL?.toLowerCase().includes(`${RESTORE_REHEARSAL_SUPABASE_REF}.supabase.co`)
  ) {
    restoreMarkers.push("SUPABASE_URL");
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

if (
  parsedEnv.data.NODE_ENV === "production" &&
  parsedEnv.data.DEMO_BILLING_MODE &&
  !parsedEnv.data.ALLOW_DEMO_BILLING_IN_PRODUCTION
) {
  throw new Error("DEMO_BILLING_MODE cannot be true in production unless ALLOW_DEMO_BILLING_IN_PRODUCTION=true.");
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

if (canonicalProductionRuntime) {
  const publicBaseUrl = new URL(parsedEnv.data.PUBLIC_BASE_URL);

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
    publicBaseUrl.protocol !== "https:"
    || publicBaseUrl.hostname !== "pintpath.au"
    || publicBaseUrl.port
    || publicBaseUrl.pathname !== "/"
    || publicBaseUrl.search
    || publicBaseUrl.hash
    || publicBaseUrl.username
    || publicBaseUrl.password
  ) {
    throw new Error("PUBLIC_BASE_URL must be exactly https://pintpath.au/ in production, with no credentials, port, path, query, or fragment. Do not use Railway preview domains as the canonical public app URL.");
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
      `Production startup blocked: missing required independent off-site backup environment ${variableLabel}: ${missingOffsiteBackupVariables.join(", ")}. ` +
      `Configure ${referenceLabel} in the production service environment and redeploy. ` +
      "OFFSITE_BACKUP_SUPABASE_URL must point to a different project/provider than SUPABASE_URL, and OFFSITE_BACKUP_SERVICE_ROLE_KEY must belong to that backup destination.",
    );
  }

  if (
    new URL(parsedEnv.data.SUPABASE_URL).origin.toLowerCase() ===
    new URL(parsedEnv.data.OFFSITE_BACKUP_SUPABASE_URL!).origin.toLowerCase()
  ) {
    throw new Error("OFFSITE_BACKUP_SUPABASE_URL must identify an independent project/provider, not the production Supabase project.");
  }

}

if (parsedEnv.data.RESTORE_REHEARSAL_MODE) {
  if (parsedEnv.data.NODE_ENV !== "production" || railwayEnvironmentName !== "staging") {
    throw new Error(
      "RESTORE_REHEARSAL_MODE is allowed only with NODE_ENV=production in the Railway environment named exactly staging.",
    );
  }

  const railwayEnvironmentId = process.env.RAILWAY_ENVIRONMENT_ID?.trim();
  if (railwayEnvironmentId !== RESTORE_REHEARSAL_RAILWAY_ENVIRONMENT_ID) {
    throw new Error("Restore rehearsal is bound to the dedicated Railway staging environment ID.");
  }
  if (process.env.RAILWAY_PROJECT_ID?.trim() !== RESTORE_REHEARSAL_RAILWAY_PROJECT_ID) {
    throw new Error("Restore rehearsal is bound to the immutable Pint Path Railway project ID.");
  }
  if (process.env.RAILWAY_SERVICE_ID?.trim() !== RESTORE_REHEARSAL_BEER_SERVICE_ID) {
    throw new Error("Restore rehearsal is bound to the immutable staging Beer Railway service ID.");
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
    !parsedEnv.data.RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL ||
    !parsedEnv.data.RESTORE_REHEARSAL_BACKUP_SUPABASE_URL
  ) {
    throw new Error(
      "Restore rehearsal requires the production and independent-backup Supabase URLs so it can prove the staging project is distinct.",
    );
  }
  const restoreSupabaseRef = canonicalSupabaseProjectRef(parsedEnv.data.SUPABASE_URL, "SUPABASE_URL");
  const productionSupabaseRef = canonicalSupabaseProjectRef(
    parsedEnv.data.RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL,
    "RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL",
  );
  const backupSupabaseRef = canonicalSupabaseProjectRef(
    parsedEnv.data.RESTORE_REHEARSAL_BACKUP_SUPABASE_URL,
    "RESTORE_REHEARSAL_BACKUP_SUPABASE_URL",
  );
  if (
    restoreSupabaseRef !== RESTORE_REHEARSAL_SUPABASE_REF ||
    productionSupabaseRef !== RESTORE_REHEARSAL_PRODUCTION_SUPABASE_REF ||
    backupSupabaseRef !== RESTORE_REHEARSAL_BACKUP_SUPABASE_REF ||
    new Set([restoreSupabaseRef, productionSupabaseRef, backupSupabaseRef]).size !== 3
  ) {
    throw new Error(
      "Restore rehearsal Supabase identities must exactly match the dedicated restore, production, and independent-backup project refs.",
    );
  }

  if (!parsedEnv.data.REDIS_URL || !parsedEnv.data.REQUIRE_REDIS_RATE_LIMITING) {
    throw new Error("Restore rehearsal requires its own REDIS_URL and REQUIRE_REDIS_RATE_LIMITING=true.");
  }
  assertCanonicalRestoreRedisUrl(parsedEnv.data.REDIS_URL);
  if (parsedEnv.data.RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID !== railwayEnvironmentId) {
    throw new Error("RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID must be a Railway reference to the current staging environment ID.");
  }
  if (parsedEnv.data.RESTORE_REHEARSAL_REDIS_SERVICE_ID !== RESTORE_REHEARSAL_REDIS_SERVICE_ID) {
    throw new Error("RESTORE_REHEARSAL_REDIS_SERVICE_ID must be the immutable staging Redis Railway service ID.");
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
