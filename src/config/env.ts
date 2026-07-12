import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

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
  SUPABASE_OAUTH_PROVIDERS: z.preprocess(sanitizeEnvString, z.string()).default("google,apple"),
  SUPABASE_MENU_CAPTURE_TABLE: optionalStringFromEnv.default("venue_menu_captures"),
  ADMIN_EMAILS: optionalStringFromEnv,
  GOOGLE_MAPS_API_KEY: optionalStringFromEnv,
  GOOGLE_MAPS_MAP_ID: optionalStringFromEnv,
  GOOGLE_PLACES_API_KEY: optionalStringFromEnv,
  OPENAI_API_KEY: optionalStringFromEnv,
  FREE_PRICE_REVEALS_PER_DAY: z.coerce.number().int().min(0).default(5),
  CONTRIBUTOR_UNLOCK_POINTS: z.coerce.number().int().min(1).default(15),
  CONTRIBUTOR_UNLOCK_DAYS: z.coerce.number().int().min(1).default(30),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  ADMIN_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(7).default(1),
  REQUIRE_ADMIN_MFA_IN_PRODUCTION: booleanFromEnv.default(true),
  ADMIN_MFA_MAX_AGE_MINUTES: z.coerce.number().int().min(5).max(1440).default(720),
  REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: booleanFromEnv.default(true),
  ANALYTICS_MIN_BUCKET_SIZE: z.coerce.number().int().min(1).max(100).default(5),
  REPORT_TIMEZONE: z.preprocess(sanitizeEnvString, z.string().min(1)).default("Australia/Melbourne"),
  REPORT_EMAIL_MODE: z.enum(["disabled", "mock"]).default("disabled"),
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
  OFFSITE_BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  OFFSITE_BACKUP_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(30),
  POS_WEBHOOK_SIGNING_SECRET: optionalStringFromEnv,
  FIELD_TEST_MODE: booleanFromEnv.default(false),
  STRIPE_SECRET_KEY: optionalStringFromEnv,
  STRIPE_WEBHOOK_SECRET: optionalStringFromEnv,
  STRIPE_PRICE_MONTHLY: optionalStringFromEnv,
  STRIPE_PRICE_YEARLY: optionalStringFromEnv,
  STRIPE_PRO_PRICE_ID: optionalStringFromEnv,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: optionalStringFromEnv,
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

if (parsedEnv.data.NODE_ENV === "production") {
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

  if (!parsedEnv.data.SOURCE_EVIDENCE_SIGNING_SECRET) {
    throw new Error("SOURCE_EVIDENCE_SIGNING_SECRET is required in production so OCR and source-evidence review links work.");
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
