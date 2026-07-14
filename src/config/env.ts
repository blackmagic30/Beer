import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

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

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
  SUPABASE_OAUTH_PROVIDERS: z.preprocess(sanitizeEnvString, z.string()).default("google,apple"),
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
  REDIS_URL: optionalStringFromEnv,
  ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: booleanFromEnv.default(false),
  DEMO_BILLING_MODE: demoBillingModeFromEnv,
  ALLOW_DEMO_BILLING_IN_PRODUCTION: booleanFromEnv.default(false),
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
  STRIPE_SECRET_KEY: optionalStringFromEnv,
  STRIPE_WEBHOOK_SECRET: optionalStringFromEnv,
  STRIPE_PRICE_MONTHLY: optionalStringFromEnv,
  STRIPE_PRICE_YEARLY: optionalStringFromEnv,
  STRIPE_PRO_PRICE_ID: optionalStringFromEnv,
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  throw new Error(`Invalid environment configuration: ${JSON.stringify(parsedEnv.error.flatten(), null, 2)}`);
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

if (parsedEnv.data.REPORT_EMAIL_MODE === "resend") {
  if (!parsedEnv.data.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is required when REPORT_EMAIL_MODE=resend.");
  }
  if (!parsedEnv.data.REPORT_EMAIL_FROM || !isSafeConfiguredEmail(parsedEnv.data.REPORT_EMAIL_FROM)) {
    throw new Error("REPORT_EMAIL_FROM must be a configured sender address when REPORT_EMAIL_MODE=resend.");
  }
}

if (parsedEnv.data.REPORT_EMAIL_REPLY_TO && !isSafeConfiguredEmail(parsedEnv.data.REPORT_EMAIL_REPLY_TO)) {
  throw new Error("REPORT_EMAIL_REPLY_TO must be a valid email address when configured.");
}

if (parsedEnv.data.REPORT_DELIVERY_SCHEDULE_ENABLED && parsedEnv.data.REPORT_EMAIL_MODE !== "resend") {
  throw new Error("REPORT_DELIVERY_SCHEDULE_ENABLED requires REPORT_EMAIL_MODE=resend.");
}

if (parsedEnv.data.NODE_ENV === "production") {
  const requireStrongSecret = (name: string, value: string | undefined) => {
    const normalized = value?.trim() ?? "";
    const documentedPlaceholder = /(?:replace[_ -]?with|change[_ -]?me|placeholder|your[_ -].*secret)/i.test(normalized);
    const repeatedCharacter = normalized.length > 0 && new Set(normalized).size < 4;
    if (Buffer.byteLength(normalized, "utf8") < 32 || documentedPlaceholder || repeatedCharacter) {
      throw new Error(`${name} must be a unique high-entropy secret of at least 32 bytes in production.`);
    }
  };
  const publicBaseUrl = new URL(parsedEnv.data.PUBLIC_BASE_URL);
  if (publicBaseUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use https:// in production.");
  }

  if (publicBaseUrl.hostname !== "pintpath.au") {
    throw new Error("PUBLIC_BASE_URL must be https://pintpath.au in production. Do not use Railway preview domains as the canonical public app URL.");
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

  if (!parsedEnv.data.DEMO_BILLING_MODE) {
    const missingStripe = [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PRICE_MONTHLY",
      "STRIPE_PRICE_YEARLY",
      "STRIPE_PRO_PRICE_ID",
    ].filter((name) => !parsedEnv.data[name as keyof typeof parsedEnv.data]);
    if (missingStripe.length) {
      throw new Error(`Real production billing requires: ${missingStripe.join(", ")}.`);
    }
  }

  requireStrongSecret("SOURCE_EVIDENCE_SIGNING_SECRET", parsedEnv.data.SOURCE_EVIDENCE_SIGNING_SECRET);
  requireStrongSecret("POS_WEBHOOK_SIGNING_SECRET", parsedEnv.data.POS_WEBHOOK_SIGNING_SECRET);

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
