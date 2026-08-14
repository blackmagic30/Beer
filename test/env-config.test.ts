import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
  TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
} from "./postgres-railway-stock-localhost-ca.fixtures.js";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function legacySupabaseJwt(
  role: "anon" | "service_role",
  signatureByte: number,
): string {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8")
      .toString("base64url"),
    Buffer.from(JSON.stringify({
      iss: "supabase",
      ref: `fixture-${signatureByte}`,
      role,
      iat: 1_700_000_000,
      exp: 2_000_000_000,
    }), "utf8").toString("base64url"),
    Buffer.alloc(32, signatureByte).toString("base64url"),
  ].join(".");
}

const legacyAnonKey = legacySupabaseJwt("anon", 1);
const legacyServiceRoleKey = legacySupabaseJwt("service_role", 2);
const legacyOffsiteServiceRoleKey = legacySupabaseJwt("service_role", 3);
const productionPublishableKey = `sb_publishable_${"a".repeat(32)}`;
const productionServiceKey = `sb_secret_${"b".repeat(32)}`;
const productionOffsiteServiceKey = `sb_secret_${"c".repeat(32)}`;
const restorePublishableKey = `sb_publishable_${"r".repeat(32)}`;
const stagingPublishableKey = `sb_publishable_${"p".repeat(32)}`;
const stagingServiceKey = `sb_secret_${"s".repeat(32)}`;
const permanentStagingSupabaseOrigin = "https://bbfibbadwjxzrcdncavy.supabase.co";
const operationalOffsiteSupabaseOrigin = "https://hfbmhdxrwtihukmixxta.supabase.co";

const productionRailwayEnvironmentId = "env-production-71b26d90";
const stagingRailwayEnvironmentId = "env-staging-40e62ca1";
const restoreRailwayEnvironmentId = "env-restore-5a821e3c";
const productionDatabaseResource = `railway:${productionRailwayEnvironmentId}:svc-postgres-1d829a`;
const stagingDatabaseResource = `railway:${stagingRailwayEnvironmentId}:svc-postgres-1d829a`;
const restoreDatabaseResource = `railway:${restoreRailwayEnvironmentId}:svc-postgres-1d829a`;
const productionRedisResource = `railway:${productionRailwayEnvironmentId}:svc-redis-4ac109`;
const stagingRedisResource = `railway:${stagingRailwayEnvironmentId}:svc-redis-4ac109`;
const restoreRedisResource = `railway:${restoreRailwayEnvironmentId}:svc-redis-4ac109`;
const productionDatabaseUrl = "postgresql://pintpath_app:fixture-password@postgres-production.railway.internal:5432/pintpath?sslmode=verify-full";
const productionMaintenanceDatabaseUrl = "postgresql://pintpath_maintenance:fixture-maintenance-password@postgres-production.railway.internal:5432/pintpath?sslmode=verify-full";
const productionRedisUrl = "redis://localhost:6379";
const stagingDatabaseUrl = "postgresql://pintpath_app:fixture-password@postgres.railway.internal:5432/pintpath?sslmode=verify-full";
const stagingMaintenanceDatabaseUrl = "postgresql://pintpath_maintenance:fixture-maintenance-password@postgres.railway.internal:5432/pintpath?sslmode=verify-full";
const stagingRedisUrl = "redis://default:fixture-password@staging-redis.railway.internal:6379";
const restoreDatabaseUrlDigest = sha256("postgresql://pintpath_restore:private@restore-postgres.internal:5432/pintpath?sslmode=require");
const restoreRedisUrlDigest = sha256("redis://default:private@restore-redis.internal:6379");

const productionRequiredEnv = {
  NODE_ENV: "production",
  PUBLIC_BASE_URL: "https://pintpath.au",
  DATABASE_URL: productionDatabaseUrl,
  DATABASE_MAINTENANCE_URL: productionMaintenanceDatabaseUrl,
  PINTPATH_POSTGRES_ROOT_CA_PEM: TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
  PINTPATH_POSTGRES_ROOT_CA_DER_SHA256:
    TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
  DATABASE_PATH: "",
  PINTPATH_IDENTITY_REGISTRY_PHASE: "complete",
  PINTPATH_DATABASE_RESOURCE_ID: productionDatabaseResource,
  PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: productionDatabaseResource,
  PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: `${stagingDatabaseResource},${restoreDatabaseResource}`,
  PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(productionDatabaseUrl),
  PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${sha256(stagingDatabaseUrl)},${restoreDatabaseUrlDigest}`,
  PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: stagingDatabaseResource,
  PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: sha256(stagingDatabaseUrl),
  ADMIN_EMAILS: "admin@example.com",
  GOOGLE_MAPS_API_KEY: "test-browser-maps-key",
  GOOGLE_MAPS_MAP_ID: "test-vector-map-id",
  GOOGLE_PLACES_API_KEY: "fixture-google-places-key",
  OPENAI_API_KEY: "test-fixture-not-a-real-menu-key",
  SOURCE_EVIDENCE_SIGNING_SECRET: "test-source-evidence-signing-secret-32-bytes",
  POS_WEBHOOK_SIGNING_SECRET: "test-pos-webhook-signing-secret-32-bytes",
  SUPABASE_URL: "https://auth.pintpath.au",
  SUPABASE_ANON_KEY: productionPublishableKey,
  SUPABASE_SERVICE_ROLE_KEY: productionServiceKey,
  SUPABASE_OAUTH_PROVIDERS: "google",
  OFFSITE_BACKUP_SUPABASE_URL: operationalOffsiteSupabaseOrigin,
  OFFSITE_BACKUP_SERVICE_ROLE_KEY: productionOffsiteServiceKey,
  REDIS_URL: productionRedisUrl,
  PINTPATH_REDIS_RESOURCE_ID: productionRedisResource,
  PINTPATH_EXPECTED_REDIS_RESOURCE_ID: productionRedisResource,
  PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: `${stagingRedisResource},${restoreRedisResource}`,
  PINTPATH_EXPECTED_REDIS_URL_SHA256: sha256(productionRedisUrl),
  PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: `${sha256(stagingRedisUrl)},${restoreRedisUrlDigest}`,
  PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: stagingRedisResource,
  PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256: sha256(stagingRedisUrl),
  REQUIRE_REDIS_RATE_LIMITING: "true",
  DEMO_BILLING_MODE: "",
  ALLOW_DEMO_BILLING_IN_PRODUCTION: "false",
  COMMERCIAL_LAUNCH_ENABLED: "false",
  CONSUMER_PAID_ENROLLMENT_ENABLED: "false",
  PINT_POINTS_REWARDS_ENABLED: "false",
  ALCOHOL_GAMIFICATION_ENABLED: "false",
  ALCOHOL_PROMOTION_APPROVAL_REFERENCE: "",
  STRIPE_SECRET_KEY: "test-fixture-not-a-real-stripe-key",
  STRIPE_WEBHOOK_SECRET: "test-fixture-not-a-real-webhook-secret",
  STRIPE_PRICE_MONTHLY: "fixture-monthly-price-id",
  STRIPE_PRICE_YEARLY: "fixture-yearly-price-id",
  STRIPE_PRO_PRICE_ID: "fixture-venue-pro-price-id",
  VENUE_PRO_TRIAL_DAYS: "0",
  VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD: "false",
  ACCOUNT_DELETION_NOTICE_MODE: "resend",
  RESEND_TRANSACTIONAL_API_KEY: "re_fixture_transactional_key",
  ACCOUNT_DELETION_NOTICE_FROM: "Pint Path <account@pintpath.au>",
  ACCOUNT_DELETION_NOTICE_REPLY_TO: "admin@pintpath.au",
  RESEND_WEBHOOK_SIGNING_SECRET: `whsec_${Buffer.alloc(32, 8).toString("base64")}`,
  ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID: "fixture-2026-08",
  ACCOUNT_DELETION_NOTICE_KEYRING_JSON: JSON.stringify({
    "fixture-2026-08": Buffer.alloc(32, 7).toString("base64"),
  }),
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID: "",
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID: "",
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID: "",
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL: "",
  ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL: "",
  ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT: "",
  RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID: "",
  RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID: "",
  RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID: "",
  RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL: "",
  RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID: "",
  RAILWAY_REPLICA_ID: "",
};

const restoreRehearsalRequiredEnv = {
  ...productionRequiredEnv,
  DATABASE_URL: "",
  DATABASE_MAINTENANCE_URL: "",
  PINTPATH_DATABASE_RESOURCE_ID: "",
  PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: "",
  PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: `${stagingDatabaseResource},${productionDatabaseResource}`,
  PINTPATH_EXPECTED_DATABASE_URL_SHA256: "",
  PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${sha256(stagingDatabaseUrl)},${sha256(productionDatabaseUrl)}`,
  PINTPATH_REDIS_RESOURCE_ID: "",
  PINTPATH_EXPECTED_REDIS_RESOURCE_ID: "",
  PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: `${stagingRedisResource},${productionRedisResource}`,
  PINTPATH_EXPECTED_REDIS_URL_SHA256: "",
  PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: `${sha256(stagingRedisUrl)},${sha256(productionRedisUrl)}`,
  RAILWAY_ENVIRONMENT_NAME: "staging",
  RAILWAY_ENVIRONMENT_ID: "fixture-restore-environment",
  RAILWAY_PROJECT_ID: "fixture-restore-project",
  RAILWAY_SERVICE_ID: "fixture-restore-app-service",
  RAILWAY_VOLUME_MOUNT_PATH: "/app/data",
  RAILWAY_PUBLIC_DOMAIN: "disposable-restore-staging.up.railway.app",
  RESTORE_REHEARSAL_MODE: "true",
  RESTORE_REHEARSAL_PHASE: "active",
  RESTORE_REHEARSAL_BACKUP_ID: "pint-path-fixture-backup",
  RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256: "a".repeat(64),
  RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256: "b".repeat(64),
  RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID: "fixture-restore-environment",
  RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID: "fixture-restore-project",
  RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID: "fixture-restore-app-service",
  RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL: "https://restoreref0000000001.supabase.co",
  RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID: "fixture-restore-redis-service",
  RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL: "https://productionref0000001.supabase.co",
  RESTORE_REHEARSAL_BACKUP_SUPABASE_URL: "https://backupref00000000001.supabase.co",
  RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID: "fixture-restore-environment",
  RESTORE_REHEARSAL_REDIS_SERVICE_ID: "fixture-restore-redis-service",
  RESTORE_REHEARSAL_REDIS_SENTINEL: "fixture-redis-sentinel-secret-32-bytes",
  RESTORE_REHEARSAL_ACCESS_USERNAME: "restore-operator",
  RESTORE_REHEARSAL_ACCESS_PASSWORD: "fixture-restore-access-password-32-bytes",
  PUBLIC_BASE_URL: "https://disposable-restore-staging.up.railway.app",
  DATABASE_PATH: "/app/data/restore-pint-path-fixture-backup/pint-path.sqlite",
  SOURCE_EVIDENCE_STORAGE_DIR: "/app/data/restore-pint-path-fixture-backup/source-evidence",
  SUPABASE_URL: "https://restoreref0000000001.supabase.co",
  SUPABASE_ANON_KEY: restorePublishableKey,
  SUPABASE_SERVICE_ROLE_KEY: stagingServiceKey,
  SUPABASE_OAUTH_PROVIDERS: "",
  REDIS_URL: "redis://default:fixture-password@redis.railway.internal:6379",
  REDIS_KEY_NAMESPACE: "pint-path:restore:fixture-restore-environment:pint-path-fixture-backup",
  REQUIRE_REDIS_RATE_LIMITING: "true",
  REPORT_EMAIL_MODE: "disabled",
  REPORT_DELIVERY_SCHEDULE_ENABLED: "false",
  RESEND_API_KEY: "",
  REPORT_EMAIL_FROM: "",
  REPORT_EMAIL_REPLY_TO: "",
  ACCOUNT_DELETION_NOTICE_MODE: "disabled",
  RESEND_TRANSACTIONAL_API_KEY: "",
  ACCOUNT_DELETION_NOTICE_FROM: "",
  ACCOUNT_DELETION_NOTICE_REPLY_TO: "",
  RESEND_WEBHOOK_SIGNING_SECRET: "",
  ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID: "",
  ACCOUNT_DELETION_NOTICE_KEYRING_JSON: "",
  OFFSITE_BACKUP_SUPABASE_URL: "",
  OFFSITE_BACKUP_SERVICE_ROLE_KEY: "",
  DEMO_BILLING_MODE: "false",
  ALLOW_DEMO_BILLING_IN_PRODUCTION: "false",
  PINT_POINTS_REWARDS_ENABLED: "false",
  ALCOHOL_GAMIFICATION_ENABLED: "false",
  ALCOHOL_PROMOTION_APPROVAL_REFERENCE: "",
  ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: "false",
  STRIPE_SECRET_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  STRIPE_PRICE_MONTHLY: "",
  STRIPE_PRICE_YEARLY: "",
  STRIPE_PRO_PRICE_ID: "",
  GOOGLE_PLACES_API_KEY: "",
  OPENAI_API_KEY: "",
  POS_WEBHOOK_SIGNING_SECRET: "",
  ADMIN_EMAILS: "",
  ADMIN_BEARER_TOKEN: "",
  ADMIN_SHARED_SECRET: "",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "",
  MENU_DISCOVERY_ADMIN_BEARER: "",
  MENU_DISCOVERY_ADMIN_BASE_URL: "",
  PINTPATH_SMOKE_BASE_URL: "",
  PINTPATH_SMOKE_USER_TOKEN: "",
  PINTPATH_SMOKE_VENUE_TOKEN: "",
  PINTPATH_SMOKE_ADMIN_TOKEN: "",
  PINTPATH_SMOKE_USER_EMAIL: "",
  PINTPATH_SMOKE_USER_PASSWORD: "",
  PINTPATH_SMOKE_VENUE_EMAIL: "",
  PINTPATH_SMOKE_VENUE_PASSWORD: "",
  PINTPATH_SMOKE_ADMIN_EMAIL: "",
  PINTPATH_SMOKE_ADMIN_PASSWORD: "",
  PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS: "false",
  ALLOW_FAKE_SEED: "false",
  MENU_DISCOVERY_QUEUE_OCR: "false",
  ALLOW_MENU_DISCOVERY_QUEUE: "false",
  PINTPATH_REPORT_DELIVER: "false",
};

const accountDeletionRehearsalRequiredEnv = {
  ...productionRequiredEnv,
  RAILWAY_ENVIRONMENT_NAME: "staging",
  RAILWAY_ENVIRONMENT_ID: stagingRailwayEnvironmentId,
  RAILWAY_PROJECT_ID: "project-pintpath-4af98c",
  RAILWAY_SERVICE_ID: "svc-pintpath-app-92d01b",
  RAILWAY_REPLICA_ID: "replica-staging-a-18c209",
  PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID: stagingRailwayEnvironmentId,
  PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID: "project-pintpath-4af98c",
  PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID: "svc-pintpath-app-92d01b",
  RAILWAY_VOLUME_MOUNT_PATH: "",
  RAILWAY_PUBLIC_DOMAIN: "permanent-staging.up.railway.app",
  PUBLIC_BASE_URL: "https://permanent-staging.up.railway.app",
  DATABASE_URL: stagingDatabaseUrl,
  DATABASE_MAINTENANCE_URL: stagingMaintenanceDatabaseUrl,
  PINTPATH_DATABASE_RESOURCE_ID: stagingDatabaseResource,
  PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: stagingDatabaseResource,
  PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: `${productionDatabaseResource},${restoreDatabaseResource}`,
  PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(stagingDatabaseUrl),
  PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${sha256(productionDatabaseUrl)},${restoreDatabaseUrlDigest}`,
  PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: stagingDatabaseResource,
  PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: sha256(stagingDatabaseUrl),
  DATABASE_PATH: "",
  SUPABASE_URL: permanentStagingSupabaseOrigin,
  SUPABASE_ANON_KEY: stagingPublishableKey,
  SUPABASE_SERVICE_ROLE_KEY: stagingServiceKey,
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID: stagingRailwayEnvironmentId,
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID: "project-pintpath-4af98c",
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID: "svc-pintpath-app-92d01b",
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL: permanentStagingSupabaseOrigin,
  ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL: "https://productionref0000001.supabase.co",
  ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT: "2",
  STRIPE_SECRET_KEY: "",
  OFFSITE_BACKUP_SUPABASE_URL: "",
  OFFSITE_BACKUP_SERVICE_ROLE_KEY: "",
  REDIS_URL: stagingRedisUrl,
  PINTPATH_REDIS_RESOURCE_ID: stagingRedisResource,
  PINTPATH_EXPECTED_REDIS_RESOURCE_ID: stagingRedisResource,
  PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: `${productionRedisResource},${restoreRedisResource}`,
  PINTPATH_EXPECTED_REDIS_URL_SHA256: sha256(stagingRedisUrl),
  PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: `${sha256(productionRedisUrl)},${restoreRedisUrlDigest}`,
  PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: stagingRedisResource,
  PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256: sha256(stagingRedisUrl),
  REDIS_KEY_NAMESPACE: "pint-path:permanent-staging",
  REQUIRE_REDIS_RATE_LIMITING: "true",
  ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: "false",
  RESTORE_REHEARSAL_MODE: "false",
  ACCOUNT_DELETION_REHEARSAL_ENABLED: "true",
};

const stagingBootstrapRequiredEnv = {
  ...productionRequiredEnv,
  RAILWAY_ENVIRONMENT_NAME: "staging",
  RAILWAY_ENVIRONMENT_ID: stagingRailwayEnvironmentId,
  RAILWAY_PROJECT_ID: "project-pintpath-4af98c",
  RAILWAY_SERVICE_ID: "svc-pintpath-app-92d01b",
  RAILWAY_PUBLIC_DOMAIN: "ordinary-staging.up.railway.app",
  PUBLIC_BASE_URL: "https://ordinary-staging.up.railway.app",
  RESTORE_REHEARSAL_MODE: "false",
  PINTPATH_IDENTITY_REGISTRY_PHASE: "staging-bootstrap",
  PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID: stagingRailwayEnvironmentId,
  PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID: "project-pintpath-4af98c",
  PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID: "svc-pintpath-app-92d01b",
  DATABASE_URL: stagingDatabaseUrl,
  DATABASE_MAINTENANCE_URL: stagingMaintenanceDatabaseUrl,
  PINTPATH_DATABASE_RESOURCE_ID: stagingDatabaseResource,
  PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: stagingDatabaseResource,
  PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: "",
  PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(stagingDatabaseUrl),
  PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: "",
  PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: stagingDatabaseResource,
  PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: sha256(stagingDatabaseUrl),
  REDIS_URL: stagingRedisUrl,
  PINTPATH_REDIS_RESOURCE_ID: stagingRedisResource,
  PINTPATH_EXPECTED_REDIS_RESOURCE_ID: stagingRedisResource,
  PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: "",
  PINTPATH_EXPECTED_REDIS_URL_SHA256: sha256(stagingRedisUrl),
  PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: "",
  PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: stagingRedisResource,
  PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256: sha256(stagingRedisUrl),
  REDIS_KEY_NAMESPACE: "pint-path:permanent-staging-bootstrap",
  SUPABASE_URL: permanentStagingSupabaseOrigin,
  SUPABASE_ANON_KEY: stagingPublishableKey,
  SUPABASE_SERVICE_ROLE_KEY: stagingServiceKey,
  OFFSITE_BACKUP_SUPABASE_URL: "",
  OFFSITE_BACKUP_SERVICE_ROLE_KEY: "",
  ACCOUNT_DELETION_NOTICE_MODE: "disabled",
  RESEND_TRANSACTIONAL_API_KEY: "",
  ACCOUNT_DELETION_NOTICE_FROM: "",
  ACCOUNT_DELETION_NOTICE_REPLY_TO: "",
  RESEND_WEBHOOK_SIGNING_SECRET: "",
  ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID: "",
  ACCOUNT_DELETION_NOTICE_KEYRING_JSON: "",
};

const stagingCompleteRequiredEnv = {
  ...stagingBootstrapRequiredEnv,
  PINTPATH_IDENTITY_REGISTRY_PHASE: "complete",
  PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS:
    `${productionDatabaseResource},${restoreDatabaseResource}`,
  PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S:
    `${sha256(productionDatabaseUrl)},${restoreDatabaseUrlDigest}`,
  PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS:
    `${productionRedisResource},${restoreRedisResource}`,
  PINTPATH_FORBIDDEN_REDIS_URL_SHA256S:
    `${sha256(productionRedisUrl)},${restoreRedisUrlDigest}`,
};

function stubProductionEnv(overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...productionRequiredEnv, ...overrides })) {
    vi.stubEnv(key, value);
  }
}

function stubRestoreRehearsalEnv(overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...restoreRehearsalRequiredEnv, ...overrides })) {
    vi.stubEnv(key, value);
  }
}

function stubAccountDeletionRehearsalEnv(overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...accountDeletionRehearsalRequiredEnv, ...overrides })) {
    vi.stubEnv(key, value);
  }
}

function stubStagingBootstrapEnv(overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...stagingBootstrapRequiredEnv, ...overrides })) {
    vi.stubEnv(key, value);
  }
}

function stubStagingCompleteEnv(overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...stagingCompleteRequiredEnv, ...overrides })) {
    vi.stubEnv(key, value);
  }
}

async function loadEnv() {
  vi.resetModules();
  return import("../src/config/env.js");
}

describe("environment safety defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults demo billing off in production when the variable is not explicitly set", async () => {
    stubProductionEnv({ DEMO_BILLING_MODE: "" });

    const { env } = await loadEnv();

    expect(env.NODE_ENV).toBe("production");
    expect(env.DEMO_BILLING_MODE).toBe(false);
    expect(env.COMMERCIAL_LAUNCH_ENABLED).toBe(false);
    expect(env.CONSUMER_PAID_ENROLLMENT_ENABLED).toBe(false);
    expect(env.OPENAI_MENU_OCR_MODEL).toBe("gpt-5.6-sol");
    expect(env.OPENAI_MENU_OCR_FALLBACK_MODEL).toBe("gpt-4.1");
    expect(env.OPENAI_MENU_OCR_REVIEW_PASS).toBe(true);
    expect(env.OPENAI_MENU_OCR_COST_BOUND_MODE).toBe(false);
  });

  it.each([
    ["unreviewed primary model", { OPENAI_MENU_OCR_MODEL: "gpt-4o" }],
    ["unreviewed fallback model", { OPENAI_MENU_OCR_FALLBACK_MODEL: "gpt-4o-mini" }],
    ["ambiguous cost flag", { OPENAI_MENU_OCR_COST_BOUND_MODE: "yes" }],
  ])("rejects %s at startup", async (_label, overrides) => {
    stubProductionEnv(overrides);

    await expect(loadEnv()).rejects.toThrow("Invalid environment configuration");
  });

  it("permits cost-bound OCR only in ordinary permanent staging with the exact snapshot", async () => {
    const exactCostBound = {
      OPENAI_MENU_OCR_COST_BOUND_MODE: "true",
      OPENAI_MENU_OCR_MODEL: "gpt-4.1-mini-2025-04-14",
      OPENAI_MENU_OCR_FALLBACK_MODEL: "gpt-4.1-mini-2025-04-14",
    };

    stubProductionEnv(exactCostBound);
    await expect(loadEnv()).rejects.toThrow(
      "OPENAI_MENU_OCR_COST_BOUND_MODE=true is permitted only in complete ordinary permanent staging",
    );

    vi.unstubAllEnvs();
    stubStagingBootstrapEnv(exactCostBound);
    await expect(loadEnv()).rejects.toThrow(
      "OPENAI_MENU_OCR_COST_BOUND_MODE=true is permitted only in complete ordinary permanent staging",
    );

    vi.unstubAllEnvs();
    stubStagingCompleteEnv({
      ...exactCostBound,
      OPENAI_MENU_OCR_FALLBACK_MODEL: "gpt-4.1",
    });
    await expect(loadEnv()).rejects.toThrow(
      "Cost-bound menu OCR requires both model variables to equal gpt-4.1-mini-2025-04-14",
    );

    vi.unstubAllEnvs();
    stubStagingCompleteEnv(exactCostBound);
    const { env } = await loadEnv();
    expect(env.OPENAI_MENU_OCR_COST_BOUND_MODE).toBe(true);
    expect(env.OPENAI_MENU_OCR_MODEL).toBe("gpt-4.1-mini-2025-04-14");
    expect(env.OPENAI_MENU_OCR_FALLBACK_MODEL).toBe("gpt-4.1-mini-2025-04-14");
  });

  it("uses exact publishable and secret keys in canonical production", async () => {
    stubProductionEnv();

    const { env } = await loadEnv();

    expect(env.SUPABASE_ANON_KEY).toBe(productionPublishableKey);
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe(productionServiceKey);
    expect(env.OFFSITE_BACKUP_SERVICE_ROLE_KEY).toBe(productionOffsiteServiceKey);
  });

  it("preserves legacy Supabase key compatibility only in local development", async () => {
    stubProductionEnv({
      NODE_ENV: "development",
      SUPABASE_ANON_KEY: legacyAnonKey,
      SUPABASE_SERVICE_ROLE_KEY: legacyServiceRoleKey,
      OFFSITE_BACKUP_SERVICE_ROLE_KEY: legacyOffsiteServiceRoleKey,
    });

    const { env } = await loadEnv();

    expect(env.SUPABASE_ANON_KEY).toBe(legacyAnonKey);
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe(legacyServiceRoleKey);
    expect(env.OFFSITE_BACKUP_SERVICE_ROLE_KEY).toBe(legacyOffsiteServiceRoleKey);
  });

  it.each([
    "https://attacker.invalid",
    "https://production-project.supabase.co",
    "http://auth.pintpath.au",
    "https://auth.pintpath.au/",
    "https://user@auth.pintpath.au",
    "https://auth.pintpath.au:443",
    "https://auth.pintpath.au/path",
    "https://auth.pintpath.au?source=production",
    "https://auth.pintpath.au#fragment",
    " https://auth.pintpath.au",
  ])("rejects noncanonical production Supabase origin %s", async (candidate) => {
    stubProductionEnv({ SUPABASE_URL: candidate });

    const error = await loadEnv().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Canonical production requires SUPABASE_URL to be the exact reviewed HTTPS origin",
    );
  });

  it.each([
    ["a secret key", `sb_secret_${"x".repeat(32)}`],
    ["a malformed publishable key", `sb_publishable_${"x".repeat(19)}`],
    ["an overlong publishable key", `sb_publishable_${"x".repeat(221)}`],
    ["an unknown sb_ key", `sb_unknown_${"x".repeat(32)}`],
    ["an arbitrary legacy-like value", "fixture-supabase-browser-key"],
    ["a structurally valid legacy anon JWT", legacyAnonKey],
    ["a legacy service-role JWT", legacyServiceRoleKey],
    [
      "a legacy anon JWT with a non-canonical signature",
      `${legacyAnonKey.split(".").slice(0, 2).join(".")}.${Buffer.alloc(31, 9).toString("base64url")}`,
    ],
    ["a whitespace-wrapped publishable key", ` ${stagingPublishableKey}`],
  ])("rejects SUPABASE_ANON_KEY containing %s before it can reach public config", async (
    _description,
    candidate,
  ) => {
    stubProductionEnv({ SUPABASE_ANON_KEY: candidate });

    const error = await loadEnv().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "must be an exact sb_publishable_ key in production",
    );
    expect((error as Error).message).not.toContain(candidate);
  });

  it.each([
    [
      "an anon JWT in the primary service slot",
      { SUPABASE_SERVICE_ROLE_KEY: legacyAnonKey },
      "SUPABASE_SERVICE_ROLE_KEY",
    ],
    [
      "a legacy service-role JWT in the primary service slot",
      { SUPABASE_SERVICE_ROLE_KEY: legacyServiceRoleKey },
      "SUPABASE_SERVICE_ROLE_KEY",
    ],
    [
      "a publishable key in the primary service slot",
      { SUPABASE_SERVICE_ROLE_KEY: stagingPublishableKey },
      "SUPABASE_SERVICE_ROLE_KEY",
    ],
    [
      "an anon JWT in the off-site service slot",
      { OFFSITE_BACKUP_SERVICE_ROLE_KEY: legacyAnonKey },
      "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
    ],
    [
      "a legacy service-role JWT in the off-site service slot",
      { OFFSITE_BACKUP_SERVICE_ROLE_KEY: legacyOffsiteServiceRoleKey },
      "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
    ],
    [
      "an arbitrary value in the off-site service slot",
      { OFFSITE_BACKUP_SERVICE_ROLE_KEY: "fixture-offsite-service-key" },
      "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
    ],
  ])("rejects current production with %s", async (_description, overrides, name) => {
    stubProductionEnv(overrides);

    const error = await loadEnv().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      `${name} must be an exact sb_secret_ key in production`,
    );
    expect((error as Error).message).not.toContain(Object.values(overrides)[0]!);
  });

  it("allows canonical production to defer Stripe and POS while both paid enrollment flags are closed", async () => {
    stubProductionEnv({
      COMMERCIAL_LAUNCH_ENABLED: "false",
      CONSUMER_PAID_ENROLLMENT_ENABLED: "false",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      STRIPE_PRICE_MONTHLY: "",
      STRIPE_PRICE_YEARLY: "",
      STRIPE_PRO_PRICE_ID: "",
      POS_WEBHOOK_SIGNING_SECRET: "",
    });

    const { env } = await loadEnv();

    expect(env.COMMERCIAL_LAUNCH_ENABLED).toBe(false);
    expect(env.CONSUMER_PAID_ENROLLMENT_ENABLED).toBe(false);
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.STRIPE_PRO_PRICE_ID).toBeUndefined();
    expect(env.POS_WEBHOOK_SIGNING_SECRET).toBeUndefined();
  });

  it.each([
    "COMMERCIAL_LAUNCH_ENABLED",
    "CONSUMER_PAID_ENROLLMENT_ENABLED",
  ] as const)("requires the complete Stripe configuration when %s is enabled", async (flag) => {
    stubProductionEnv({
      COMMERCIAL_LAUNCH_ENABLED: "false",
      CONSUMER_PAID_ENROLLMENT_ENABLED: "false",
      [flag]: "true",
      ...(flag === "COMMERCIAL_LAUNCH_ENABLED" ? { VENUE_PRO_TRIAL_DAYS: "60" } : {}),
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      STRIPE_PRICE_MONTHLY: "",
      STRIPE_PRICE_YEARLY: "",
      STRIPE_PRO_PRICE_ID: "",
    });

    await expect(loadEnv()).rejects.toThrow("Canonical PostgreSQL currently supports the frozen Free launch only");
  });

  it("keeps paid enrollment inert while permanent staging is in identity bootstrap", async () => {
    stubStagingBootstrapEnv({
      COMMERCIAL_LAUNCH_ENABLED: "true",
      CONSUMER_PAID_ENROLLMENT_ENABLED: "false",
      VENUE_PRO_TRIAL_DAYS: "60",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      STRIPE_PRICE_MONTHLY: "",
      STRIPE_PRICE_YEARLY: "",
      STRIPE_PRO_PRICE_ID: "",
    });

    await expect(loadEnv()).rejects.toThrow("identity bootstrap requires the inert Free scope");
  });

  it("requires Postgres and rejects SQLite in ordinary hosted staging", async () => {
    stubStagingBootstrapEnv({
      DATABASE_URL: "",
      DATABASE_PATH: "",
    });
    await expect(loadEnv()).rejects.toThrow(
      "DATABASE_URL must be a valid TLS Postgres connection URL",
    );

    vi.resetModules();
    stubStagingBootstrapEnv({
      DATABASE_PATH: "/app/data/pint-path.sqlite",
    });
    await expect(loadEnv()).rejects.toThrow("must not configure DATABASE_PATH");
  });

  it("requires a distinct maintenance login on the exact application database", async () => {
    stubProductionEnv({ DATABASE_MAINTENANCE_URL: "" });
    await expect(loadEnv()).rejects.toThrow("DATABASE_MAINTENANCE_URL must be a valid TLS Postgres connection URL");

    vi.resetModules();
    stubProductionEnv({ DATABASE_MAINTENANCE_URL: productionDatabaseUrl });
    await expect(loadEnv()).rejects.toThrow("dedicated maintenance login distinct from the web runtime login");

    vi.resetModules();
    stubProductionEnv({
      DATABASE_MAINTENANCE_URL:
        "postgresql://pintpath_maintenance:fixture@other-postgres.railway.internal:5432/pintpath?sslmode=verify-full",
    });
    await expect(loadEnv()).rejects.toThrow("same pinned Postgres host, port, and database");

    vi.resetModules();
    stubProductionEnv({
      DATABASE_URL:
        "postgresql://runtime_login:fixture@production-postgres.internal:6543/pintpath?sslmode=require",
      DATABASE_MAINTENANCE_URL:
        "postgresql://maintenance_login:fixture@production-postgres.internal:6543/pintpath?sslmode=require",
    });
    await expect(loadEnv()).rejects.toThrow(
      "must use the explicit direct/session Postgres port 5432",
    );
  });

  it.each([
    ["missing PEM", { PINTPATH_POSTGRES_ROOT_CA_PEM: "" }],
    ["missing DER pin", { PINTPATH_POSTGRES_ROOT_CA_DER_SHA256: "" }],
  ])("rejects hosted Postgres with %s", async (_label, overrides) => {
    stubProductionEnv(overrides);
    await expect(loadEnv()).rejects.toThrow(
      "requires PINTPATH_POSTGRES_ROOT_CA_PEM",
    );
  });

  it("rejects a hosted Postgres CA that does not match the reviewed DER pin", async () => {
    stubProductionEnv({
      PINTPATH_POSTGRES_ROOT_CA_DER_SHA256: "0".repeat(64),
    });
    await expect(loadEnv()).rejects.toThrow(
      "one valid self-signed Railway CA matching",
    );
  });

  it("rejects sslmode=require before hosted Postgres pool construction", async () => {
    const databaseUrl = productionDatabaseUrl.replace(
      "sslmode=verify-full",
      "sslmode=require",
    );
    stubProductionEnv({
      DATABASE_URL: databaseUrl,
      PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(databaseUrl),
    });
    await expect(loadEnv()).rejects.toThrow(
      "only sslmode=verify-full",
    );
  });

  it.each(["production", "staging"])(
    "rejects a hosted Railway %s runtime when NODE_ENV is absent or development",
    async (railwayEnvironmentName) => {
      stubProductionEnv({
        RAILWAY_ENVIRONMENT_NAME: railwayEnvironmentName,
      });
      delete process.env.NODE_ENV;

      await expect(loadEnv()).rejects.toThrow(
        "Hosted Railway production and staging application runtimes require NODE_ENV=production",
      );

      vi.resetModules();
      stubProductionEnv({
        NODE_ENV: "development",
        RAILWAY_ENVIRONMENT_NAME: railwayEnvironmentName,
      });

      await expect(loadEnv()).rejects.toThrow(
        "Hosted Railway production and staging application runtimes require NODE_ENV=production",
      );
    },
  );

  it("keeps real monthly report delivery and scheduling disabled by default", async () => {
    stubProductionEnv();

    const { env } = await loadEnv();

    expect(env.REPORT_EMAIL_MODE).toBe("disabled");
    expect(env.REPORT_DELIVERY_SCHEDULE_ENABLED).toBe(false);
    expect(env.REPORT_DELIVERY_DAY).toBe(2);
    expect(env.REPORT_DELIVERY_HOUR).toBe(9);
  });

  it("requires the encrypted Resend completion-notice path in canonical production", async () => {
    stubProductionEnv({ ACCOUNT_DELETION_NOTICE_MODE: "disabled" });

    await expect(loadEnv()).rejects.toThrow(
      "Canonical production requires ACCOUNT_DELETION_NOTICE_MODE=resend",
    );
  });

  it("keeps Apple OAuth disabled until authorization-token revocation is implemented", async () => {
    stubProductionEnv({ SUPABASE_OAUTH_PROVIDERS: "google,apple" });

    await expect(loadEnv()).rejects.toThrow(
      "Apple OAuth must remain disabled until Apple authorization-token revocation is implemented and tested",
    );
  });

  it("rejects a deletion-notice keyring that does not contain an exact 32-byte active key", async () => {
    stubProductionEnv({
      ACCOUNT_DELETION_NOTICE_KEYRING_JSON: JSON.stringify({ "fixture-2026-08": "dG9vLXNob3J0" }),
    });

    await expect(loadEnv()).rejects.toThrow("must decode to exactly 32 bytes");
  });

  it("rejects a deletion-notice webhook secret that was not copied from Resend", async () => {
    stubProductionEnv({ RESEND_WEBHOOK_SIGNING_SECRET: "not-a-resend-webhook-secret" });

    await expect(loadEnv()).rejects.toThrow(
      "RESEND_WEBHOOK_SIGNING_SECRET must be the valid whsec_ secret copied from the Resend webhook",
    );
  });

  it("keeps the venue offer and alcohol-linked launch features disabled by default", async () => {
    stubProductionEnv();

    const { env } = await loadEnv();

    expect(env.VENUE_PRO_TRIAL_DAYS).toBe(0);
    expect(env.VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD).toBe(false);
    expect(env.PINT_POINTS_REWARDS_ENABLED).toBe(false);
    expect(env.ALCOHOL_GAMIFICATION_ENABLED).toBe(false);
  });

  it("keeps future commercial enrollment closed until its Postgres repositories exist", async () => {
    stubProductionEnv({
      COMMERCIAL_LAUNCH_ENABLED: "true",
      VENUE_PRO_TRIAL_DAYS: "60",
    });

    await expect(loadEnv()).rejects.toThrow("Canonical PostgreSQL currently supports the frozen Free launch only");
  });

  it("keeps consumer paid enrollment closed in the canonical Postgres runtime", async () => {
    stubProductionEnv({
      COMMERCIAL_LAUNCH_ENABLED: "true",
      CONSUMER_PAID_ENROLLMENT_ENABLED: "false",
      VENUE_PRO_TRIAL_DAYS: "60",
    });

    await expect(loadEnv()).rejects.toThrow("Canonical PostgreSQL currently supports the frozen Free launch only");
  });

  it("accepts only disabled, 30-day, or 60-day venue trial lengths", async () => {
    stubProductionEnv({ VENUE_PRO_TRIAL_DAYS: "45" });

    await expect(loadEnv()).rejects.toThrow("Use 0, 30, or 60 days");
  });

  it("requires the deferred release to keep the venue trial disabled", async () => {
    stubProductionEnv({ VENUE_PRO_TRIAL_DAYS: "60" });
    await expect(loadEnv()).rejects.toThrow("Pricing is deferred");

    vi.resetModules();
    stubProductionEnv({ VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD: "true" });
    await expect(loadEnv()).rejects.toThrow("Pricing is deferred");
  });

  it("fails a future commercial launch closed unless its current offer contract is 60 days with no payment method", async () => {
    stubProductionEnv({ COMMERCIAL_LAUNCH_ENABLED: "true", VENUE_PRO_TRIAL_DAYS: "30" });
    await expect(loadEnv()).rejects.toThrow("non-converting 60-day venue Pro offer");

    vi.resetModules();
    stubProductionEnv({
      COMMERCIAL_LAUNCH_ENABLED: "true",
      VENUE_PRO_TRIAL_DAYS: "60",
      VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD: "true",
    });
    await expect(loadEnv()).rejects.toThrow("non-converting 60-day venue Pro offer");
  });

  it("blocks alcohol-linked launch features without a recorded approval reference", async () => {
    stubProductionEnv({
      PINT_POINTS_REWARDS_ENABLED: "true",
      ALCOHOL_PROMOTION_APPROVAL_REFERENCE: "",
    });

    await expect(loadEnv()).rejects.toThrow("ALCOHOL_PROMOTION_APPROVAL_REFERENCE");
  });

  it("keeps approved alcohol features closed until the Postgres implementation exists", async () => {
    stubProductionEnv({
      ALCOHOL_GAMIFICATION_ENABLED: "true",
      ALCOHOL_PROMOTION_APPROVAL_REFERENCE: "legal-and-app-review-ticket-2026-07-28",
    });

    await expect(loadEnv()).rejects.toThrow("Canonical PostgreSQL currently supports the frozen Free launch only");
  });

  it("rejects invalid report timezones before reports or scheduler timers start", async () => {
    stubProductionEnv({ REPORT_TIMEZONE: "Mars/HappyHour" });

    await expect(loadEnv()).rejects.toThrow("valid IANA timezone");
  });

  it("fails closed when Resend mode is missing delivery credentials", async () => {
    stubProductionEnv({
      REPORT_EMAIL_MODE: "resend",
      RESEND_API_KEY: "",
      REPORT_EMAIL_FROM: "Pint Path <reports@pintpath.au>",
      REPORT_EMAIL_REPLY_TO: "admin@pintpath.au",
    });

    await expect(loadEnv()).rejects.toThrow("RESEND_API_KEY is required");
  });

  it("fails closed when Resend mode has no monitored reply mailbox", async () => {
    stubProductionEnv({
      REPORT_EMAIL_MODE: "resend",
      RESEND_API_KEY: "re_test_report_delivery",
      REPORT_EMAIL_FROM: "Pint Path <reports@pintpath.au>",
      REPORT_EMAIL_REPLY_TO: "",
    });

    await expect(loadEnv()).rejects.toThrow(
      "REPORT_EMAIL_REPLY_TO must be a monitored valid email address when REPORT_EMAIL_MODE=resend",
    );
  });

  it("rejects an invalid reply mailbox before enabling Resend delivery", async () => {
    stubProductionEnv({
      REPORT_EMAIL_MODE: "resend",
      RESEND_API_KEY: "re_test_report_delivery",
      REPORT_EMAIL_FROM: "Pint Path <reports@pintpath.au>",
      REPORT_EMAIL_REPLY_TO: "not-an-email",
    });

    await expect(loadEnv()).rejects.toThrow(
      "REPORT_EMAIL_REPLY_TO must be a monitored valid email address when REPORT_EMAIL_MODE=resend",
    );
  });

  it("rejects the mock report transport in production", async () => {
    stubProductionEnv({ REPORT_EMAIL_MODE: "mock" });

    await expect(loadEnv()).rejects.toThrow("REPORT_EMAIL_MODE=mock is test-only");
  });

  it("does not allow the automatic report schedule with a non-sending email mode", async () => {
    stubProductionEnv({
      REPORT_EMAIL_MODE: "disabled",
      REPORT_DELIVERY_SCHEDULE_ENABLED: "true",
    });

    await expect(loadEnv()).rejects.toThrow(
      "REPORT_DELIVERY_SCHEDULE_ENABLED requires REPORT_EMAIL_MODE=resend",
    );
  });

  it("accepts explicit Resend credentials before enabling the report schedule", async () => {
    stubProductionEnv({
      REPORT_EMAIL_MODE: "resend",
      RESEND_API_KEY: "re_test_report_delivery",
      REPORT_EMAIL_FROM: "Pint Path <reports@pintpath.au>",
      REPORT_EMAIL_REPLY_TO: "admin@pintpath.au",
      REPORT_DELIVERY_SCHEDULE_ENABLED: "true",
    });

    const { env } = await loadEnv();

    expect(env.REPORT_EMAIL_MODE).toBe("resend");
    expect(env.REPORT_EMAIL_REPLY_TO).toBe("admin@pintpath.au");
    expect(env.REPORT_DELIVERY_SCHEDULE_ENABLED).toBe(true);
  });

  it("does not block public production boot while the official admin email is pending", async () => {
    stubProductionEnv({ ADMIN_EMAILS: "", DEMO_BILLING_MODE: "" });

    const { env } = await loadEnv();

    expect(env.NODE_ENV).toBe("production");
    expect(env.ADMIN_EMAILS).toBeUndefined();
  });

  it("requires source evidence signing in production so review links do not fail later", async () => {
    stubProductionEnv({
      ADMIN_EMAILS: "",
      DEMO_BILLING_MODE: "",
      SOURCE_EVIDENCE_SIGNING_SECRET: "",
    });

    await expect(loadEnv()).rejects.toThrow(
      "SOURCE_EVIDENCE_SIGNING_SECRET must be a unique high-entropy secret",
    );
  });

  it("rejects short and documented-placeholder HMAC secrets in production", async () => {
    stubProductionEnv({ SOURCE_EVIDENCE_SIGNING_SECRET: "short" });
    await expect(loadEnv()).rejects.toThrow("SOURCE_EVIDENCE_SIGNING_SECRET must be a unique high-entropy secret");

    stubProductionEnv({ SOURCE_EVIDENCE_SIGNING_SECRET: "replace_with_32_plus_random_characters" });
    await expect(loadEnv()).rejects.toThrow("SOURCE_EVIDENCE_SIGNING_SECRET must be a unique high-entropy secret");

    stubProductionEnv({ POS_WEBHOOK_SIGNING_SECRET: "short" });
    await expect(loadEnv()).rejects.toThrow("POS_WEBHOOK_SIGNING_SECRET must be a unique high-entropy secret");
  });

  it("blocks canonical production boot without shared fail-closed Redis", async () => {
    stubProductionEnv({
      ADMIN_EMAILS: "",
      DEMO_BILLING_MODE: "",
      REDIS_URL: "",
    });

    await expect(loadEnv()).rejects.toThrow("Canonical production requires shared REDIS_URL");
  });

  it("rejects a canonical production SQLite runtime path", async () => {
    stubProductionEnv({ DATABASE_PATH: "/app/data/pint-path.sqlite" });
    await expect(loadEnv()).rejects.toThrow("must not configure DATABASE_PATH");
  });

  it.each([
    [
      "a URL fragment",
      `${productionRequiredEnv.DATABASE_URL}#unexpected-fragment`,
    ],
    [
      "more than one sslmode parameter",
      `${productionRequiredEnv.DATABASE_URL}&sslmode=disable`,
    ],
  ])("rejects a canonical production Postgres URL with %s", async (_description, databaseUrl) => {
    stubProductionEnv({
      DATABASE_URL: databaseUrl,
      PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(databaseUrl),
    });

    await expect(loadEnv()).rejects.toThrow("sslmode=require, verify-ca, or verify-full");
  });

  it.each([
    {
      description: "both backup credentials are absent",
      overrides: {
        OFFSITE_BACKUP_SUPABASE_URL: "",
        OFFSITE_BACKUP_SERVICE_ROLE_KEY: "",
      },
      expectedVariables: "OFFSITE_BACKUP_SUPABASE_URL, OFFSITE_BACKUP_SERVICE_ROLE_KEY",
      expectedLabel: "variables",
      expectedReference: "them",
    },
    {
      description: "only the backup URL is absent",
      overrides: { OFFSITE_BACKUP_SUPABASE_URL: "   " },
      expectedVariables: "OFFSITE_BACKUP_SUPABASE_URL",
      expectedLabel: "variable",
      expectedReference: "it",
    },
    {
      description: "only the backup service-role key is absent",
      overrides: { OFFSITE_BACKUP_SERVICE_ROLE_KEY: "''" },
      expectedVariables: "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
      expectedLabel: "variable",
      expectedReference: "it",
    },
  ])("fails closed with an actionable, secret-safe diagnostic when $description", async ({
    overrides,
    expectedVariables,
    expectedLabel,
    expectedReference,
  }) => {
    stubProductionEnv(overrides);

    const error = await loadEnv().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(
      `missing required private operational restore-copy environment ${expectedLabel}: ${expectedVariables}`,
    );
    expect(message).toContain(`Configure ${expectedReference} in the production service environment and redeploy.`);
    expect(message).toContain("must point to an origin different from SUPABASE_URL");
    expect(message).toContain("does not replace separately verified WORM disaster recovery");
    expect(message).not.toContain(productionRequiredEnv.OFFSITE_BACKUP_SERVICE_ROLE_KEY);
  });

  it("rejects an off-site backup destination that resolves to the production Supabase origin", async () => {
    stubProductionEnv({
      OFFSITE_BACKUP_SUPABASE_URL: "HTTPS://AUTH.PINTPATH.AU/backup/",
    });

    await expect(loadEnv()).rejects.toThrow(
      "Canonical production requires OFFSITE_BACKUP_SUPABASE_URL to be the exact reviewed operational-copy HTTPS origin",
    );
  });

  it("blocks demo billing and its legacy override in production", async () => {
    stubProductionEnv({ DEMO_BILLING_MODE: "true" });

    await expect(loadEnv()).rejects.toThrow(
      "Production requires DEMO_BILLING_MODE=false and ALLOW_DEMO_BILLING_IN_PRODUCTION=false.",
    );

    stubProductionEnv({
      DEMO_BILLING_MODE: "false",
      ALLOW_DEMO_BILLING_IN_PRODUCTION: "true",
    });

    await expect(loadEnv()).rejects.toThrow(
      "Production requires DEMO_BILLING_MODE=false and ALLOW_DEMO_BILLING_IN_PRODUCTION=false.",
    );
  });

  it("allows admin MFA to be temporarily disabled for owner-led production field testing", async () => {
    stubProductionEnv({
      DEMO_BILLING_MODE: "",
      REQUIRE_ADMIN_MFA_IN_PRODUCTION: "false",
    });

    const { env } = await loadEnv();

    expect(env.NODE_ENV).toBe("production");
    expect(env.REQUIRE_ADMIN_MFA_IN_PRODUCTION).toBe(false);
  });

  it.each([
    " https://pintpath.au",
    "https://pintpath.au ",
    "HTTPS://PINTPATH.AU",
    "https://pintpath.au/",
    "https://beer-production-aad4.up.railway.app",
    "https://user:password@pintpath.au/",
    "https://pintpath.au:444/",
    "https://pintpath.au/app",
    "https://pintpath.au/?preview=true",
    "https://pintpath.au/#preview",
  ])("rejects a non-canonical production PUBLIC_BASE_URL: %s", async (publicBaseUrl) => {
    stubProductionEnv({ PUBLIC_BASE_URL: publicBaseUrl });

    await expect(loadEnv()).rejects.toThrow(
      "PUBLIC_BASE_URL must be exactly https://pintpath.au in production",
    );
  });

  it("accepts only a fully isolated Railway staging restore rehearsal", async () => {
    stubRestoreRehearsalEnv();

    const { env } = await loadEnv();

    expect(env.RESTORE_REHEARSAL_MODE).toBe(true);
    expect(env.PUBLIC_BASE_URL).toBe("https://disposable-restore-staging.up.railway.app");
    expect(env.DATABASE_PATH).toBe("/app/data/restore-pint-path-fixture-backup/pint-path.sqlite");
    expect(env.OFFSITE_BACKUP_SUPABASE_URL).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it.each([
    "RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID",
    "RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID",
    "RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID",
  ])("requires the reviewed disposable-restore identity pin %s", async (name) => {
    stubRestoreRehearsalEnv({ [name]: "" });

    await expect(loadEnv()).rejects.toThrow(`Restore rehearsal requires reviewed Railway identity pins: ${name}`);
  });

  it("requires reviewed disposable Supabase and Redis pins instead of checked-in resource IDs", async () => {
    stubRestoreRehearsalEnv({ RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL: "" });
    await expect(loadEnv()).rejects.toThrow("requires reviewed restore, production, and operational-restore-copy Supabase URL pins");

    stubRestoreRehearsalEnv({ RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID: "" });
    await expect(loadEnv()).rejects.toThrow("must match the reviewed disposable Redis service pin");

    const source = fs.readFileSync(path.resolve(process.cwd(), "src/config/env.ts"), "utf8");
    expect(source).not.toMatch(/^const (?:RESTORE_REHEARSAL|ACCOUNT_DELETION_REHEARSAL)_[A-Z_]+\s*=/m);
    expect(accountDeletionRehearsalRequiredEnv.RAILWAY_PROJECT_ID)
      .not.toBe(restoreRehearsalRequiredEnv.RAILWAY_PROJECT_ID);
    expect(accountDeletionRehearsalRequiredEnv.RAILWAY_ENVIRONMENT_ID)
      .not.toBe(restoreRehearsalRequiredEnv.RAILWAY_ENVIRONMENT_ID);
    expect(accountDeletionRehearsalRequiredEnv.RAILWAY_SERVICE_ID)
      .not.toBe(restoreRehearsalRequiredEnv.RAILWAY_SERVICE_ID);
    expect(accountDeletionRehearsalRequiredEnv.SUPABASE_URL)
      .not.toBe(restoreRehearsalRequiredEnv.SUPABASE_URL);
  });

  it("fails closed when the restore mode flag is disabled but restore-shaped configuration remains", async () => {
    stubRestoreRehearsalEnv({ RESTORE_REHEARSAL_MODE: "false" });

    await expect(loadEnv()).rejects.toThrow("Restore-shaped configuration or volume contents require");
  });

  it("allows permanent staging to bootstrap exact Postgres and Redis self pins before sibling resources exist", async () => {
    stubStagingBootstrapEnv();

    const { env, assertApplicationServerStartAllowed } = await loadEnv();
    expect(env.RESTORE_REHEARSAL_MODE).toBe(false);
    expect(env.PUBLIC_BASE_URL).toBe("https://ordinary-staging.up.railway.app");
    expect(env.PINTPATH_IDENTITY_REGISTRY_PHASE).toBe("staging-bootstrap");
    expect(env.PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS).toBeUndefined();
    expect(env.PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS).toBeUndefined();
    expect(() => assertApplicationServerStartAllowed()).toThrow(
      "identity bootstrap is operator-only",
    );
  });

  it("requires exact new publishable and primary secret keys throughout permanent-staging bootstrap", async () => {
    for (const [overrides, expectedName] of [
      [{ SUPABASE_ANON_KEY: legacyAnonKey }, "SUPABASE_ANON_KEY"],
      [{ SUPABASE_SERVICE_ROLE_KEY: legacyServiceRoleKey }, "SUPABASE_SERVICE_ROLE_KEY"],
      [{ SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"b".repeat(20)}!` }, "SUPABASE_SERVICE_ROLE_KEY"],
    ] as const) {
      vi.unstubAllEnvs();
      stubStagingBootstrapEnv({ ...overrides });
      const error = await loadEnv().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("permanent-staging-bootstrap");
      expect((error as Error).message).toContain(expectedName);
      expect((error as Error).message).not.toContain(Object.values(overrides)[0]);
    }
  });

  it("prohibits production operational-backup authority throughout staging bootstrap", async () => {
    stubStagingBootstrapEnv();
    await expect(loadEnv()).resolves.toBeDefined();

    for (const overrides of [
      { OFFSITE_BACKUP_SUPABASE_URL: operationalOffsiteSupabaseOrigin },
      { OFFSITE_BACKUP_SERVICE_ROLE_KEY: `sb_secret_${"o".repeat(32)}` },
      { OFFSITE_BACKUP_BUCKET: "pintpath-backups" },
      { OFFSITE_BACKUP_SUPABASE_URL: " " },
      { OFFSITE_BACKUP_SERVICE_ROLE_KEY: " " },
      { OFFSITE_BACKUP_BUCKET: " " },
    ]) {
      vi.unstubAllEnvs();
      stubStagingBootstrapEnv(overrides);
      const error = await loadEnv().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "permanent-staging-bootstrap) prohibits OFFSITE_BACKUP_SUPABASE_URL, OFFSITE_BACKUP_SERVICE_ROLE_KEY, and OFFSITE_BACKUP_BUCKET",
      );
      const rejectedValue = Object.values(overrides)[0];
      if (rejectedValue.trim().length > 0) {
        expect((error as Error).message).not.toContain(rejectedValue);
      }
    }
  });

  it("requires the two exact project keys and prohibits off-site authority once permanent staging is complete", async () => {
    for (const payloadLength of [20, 220]) {
      vi.unstubAllEnvs();
      stubStagingCompleteEnv({
        SUPABASE_ANON_KEY: `sb_publishable_${"a".repeat(payloadLength)}`,
        SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"b".repeat(payloadLength)}`,
      });
      await expect(loadEnv()).resolves.toBeDefined();
    }

    vi.unstubAllEnvs();
    stubStagingCompleteEnv({
      OFFSITE_BACKUP_SUPABASE_URL: operationalOffsiteSupabaseOrigin,
      OFFSITE_BACKUP_SERVICE_ROLE_KEY: `sb_secret_${"c".repeat(32)}`,
      OFFSITE_BACKUP_BUCKET: "pintpath-backups",
    });
    await expect(loadEnv()).rejects.toThrow(
      "permanent-staging-complete) prohibits OFFSITE_BACKUP_SUPABASE_URL, OFFSITE_BACKUP_SERVICE_ROLE_KEY, and OFFSITE_BACKUP_BUCKET",
    );
  });

  it.each([
    ["production", { RAILWAY_ENVIRONMENT_NAME: "production" }],
    ["restore", { RESTORE_REHEARSAL_MODE: "true" }],
    ["account-deletion rehearsal", { ACCOUNT_DELETION_REHEARSAL_ENABLED: "true" }],
  ])("rejects the staging-bootstrap phase in %s", async (_label, overrides) => {
    stubStagingBootstrapEnv(overrides);

    await expect(loadEnv()).rejects.toThrow(
      "staging-bootstrap is allowed only in ordinary permanent staging",
    );
  });

  it.each([
    ["database sibling URL", { PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: sha256(productionDatabaseUrl) }],
    ["database sibling resource", { PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: productionDatabaseResource }],
    ["Redis sibling URL", { PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: sha256(productionRedisUrl) }],
    ["Redis sibling resource", { PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: productionRedisResource }],
  ])("rejects invented or premature %s values during staging bootstrap", async (_label, overrides) => {
    stubStagingBootstrapEnv(overrides);

    await expect(loadEnv()).rejects.toThrow("sibling identity lists to remain absent");
  });

  it.each([
    ["placeholder database resource", { PINTPATH_DATABASE_RESOURCE_ID: "railway:env-staging:fixture-postgres" }],
    ["placeholder Redis resource", { PINTPATH_REDIS_RESOURCE_ID: "railway:env-staging:placeholder-redis" }],
    ["shared database service ID", { PINTPATH_DATABASE_RESOURCE_ID: "svc-postgres-1d829a", PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: "svc-postgres-1d829a", PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: "svc-postgres-1d829a" }],
    ["wrong-environment database instance", { PINTPATH_DATABASE_RESOURCE_ID: productionDatabaseResource, PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: productionDatabaseResource, PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: productionDatabaseResource }],
  ])("rejects %s during staging bootstrap", async (_label, overrides) => {
    stubStagingBootstrapEnv(overrides);

    await expect(loadEnv()).rejects.toThrow();
  });

  it.each([
    ["database URL", { PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: sha256(productionDatabaseUrl) }],
    ["database resource", { PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: productionDatabaseResource }],
    ["Redis URL", { PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256: sha256(productionRedisUrl) }],
    ["Redis resource", { PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: productionRedisResource }],
  ])("requires the named permanent-staging %s pin to match its live self pin", async (_label, overrides) => {
    stubStagingBootstrapEnv(overrides);

    await expect(loadEnv()).rejects.toThrow("named database and Redis URL/resource pins");
  });

  it("allows deletion rehearsal only on the reviewed permanent Postgres staging stack", async () => {
    stubAccountDeletionRehearsalEnv();

    const { env } = await loadEnv();
    expect(env.ACCOUNT_DELETION_REHEARSAL_ENABLED).toBe(true);
    expect(env.PUBLIC_BASE_URL).toBe("https://permanent-staging.up.railway.app");
    expect(env.DATABASE_URL).toContain("postgresql://");
    expect(env.SUPABASE_URL).toBe(permanentStagingSupabaseOrigin);
    expect(env.OFFSITE_BACKUP_SUPABASE_URL).toBeUndefined();
    expect(env.OFFSITE_BACKUP_SERVICE_ROLE_KEY).toBeUndefined();
    expect(env.REDIS_URL).toContain("staging-redis.railway.internal");
    expect(env.REQUIRE_REDIS_RATE_LIMITING).toBe(true);
    expect(env.ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION).toBe(false);
    expect(env.ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT).toBe(2);
  });

  it("requires exact new primary Supabase roles in account-deletion rehearsal", async () => {
    stubAccountDeletionRehearsalEnv({ SUPABASE_SERVICE_ROLE_KEY: legacyServiceRoleKey });

    await expect(loadEnv()).rejects.toThrow(
      "account-deletion-rehearsal) requires SUPABASE_SERVICE_ROLE_KEY",
    );
  });

  it("rejects deletion rehearsal when permanent-staging identities or providers do not match", async () => {
    for (const [overrides, expected] of [
      [{ RAILWAY_PROJECT_ID: "wrong-project" }, "RAILWAY_PROJECT_ID"],
      [{ RAILWAY_ENVIRONMENT_ID: "wrong-environment" }, "RAILWAY_ENVIRONMENT_ID"],
      [{ RAILWAY_SERVICE_ID: "wrong-service" }, "RAILWAY_SERVICE_ID"],
      [{ PUBLIC_BASE_URL: "https://pintpath.au", RAILWAY_PUBLIC_DOMAIN: "pintpath.au" }, "exact isolated staging HTTPS origin"],
      [{ SUPABASE_URL: "https://productionref0000001.supabase.co" }, "does not match the reviewed permanent-staging Supabase pin"],
      [{ OFFSITE_BACKUP_SUPABASE_URL: "https://backup.example.com" }, "prohibits off-site backup credentials"],
      [{ OFFSITE_BACKUP_SERVICE_ROLE_KEY: "forbidden-backup-key" }, "prohibits off-site backup credentials"],
      [{ REDIS_URL: "" }, "requires its dedicated shared REDIS_URL"],
      [{ PINTPATH_EXPECTED_DATABASE_URL_SHA256: "c".repeat(64) }, "database does not match its reviewed environment identity"],
      [{ PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${accountDeletionRehearsalRequiredEnv.PINTPATH_EXPECTED_DATABASE_URL_SHA256},${"e".repeat(64)}` }, "database does not match its reviewed environment identity"],
      [{ PINTPATH_EXPECTED_REDIS_URL_SHA256: "d".repeat(64) }, "redis does not match its reviewed environment identity"],
      [{ PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: `${accountDeletionRehearsalRequiredEnv.PINTPATH_EXPECTED_REDIS_URL_SHA256},${"f".repeat(64)}` }, "redis does not match its reviewed environment identity"],
      [{ PINTPATH_DATABASE_RESOURCE_ID: productionDatabaseResource }, "database does not match its reviewed provider resource"],
      [{ PINTPATH_REDIS_RESOURCE_ID: productionRedisResource }, "redis does not match its reviewed provider resource"],
      [{ REQUIRE_REDIS_RATE_LIMITING: "false" }, "REQUIRE_REDIS_RATE_LIMITING=true"],
      [{ ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: "true" }, "ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false"],
      [{ COMMERCIAL_LAUNCH_ENABLED: "true" }, "Free-only feature scope"],
      [{ REPORT_EMAIL_MODE: "resend" }, "Free-only feature scope"],
    ] as const) {
      vi.unstubAllEnvs();
      stubAccountDeletionRehearsalEnv({ ...overrides });
      await expect(loadEnv()).rejects.toThrow(expected);
    }
  });

  it.each([
    [
      "one database forbidden URL digest",
      { PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: "e".repeat(64) },
      "PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S",
    ],
    [
      "duplicate database forbidden URL digests",
      { PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${"e".repeat(64)},${"e".repeat(64)}` },
      "PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S",
    ],
    [
      "one Redis forbidden URL digest",
      { PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: "f".repeat(64) },
      "PINTPATH_FORBIDDEN_REDIS_URL_SHA256S",
    ],
    [
      "duplicate Redis forbidden URL digests",
      { PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: `${"f".repeat(64)},${"f".repeat(64)}` },
      "PINTPATH_FORBIDDEN_REDIS_URL_SHA256S",
    ],
    [
      "one database forbidden resource ID",
      { PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: productionDatabaseResource },
      "PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS",
    ],
    [
      "duplicate database forbidden resource IDs",
      { PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: `${productionDatabaseResource},${productionDatabaseResource}` },
      "PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS",
    ],
    [
      "one Redis forbidden resource ID",
      { PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: productionRedisResource },
      "PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS",
    ],
    [
      "duplicate Redis forbidden resource IDs",
      { PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: `${productionRedisResource},${productionRedisResource}` },
      "PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS",
    ],
  ])("rejects deletion rehearsal with %s", async (_description, overrides, variableName) => {
    stubAccountDeletionRehearsalEnv(overrides);

    await expect(loadEnv()).rejects.toThrow(
      `${variableName} must contain at least two distinct`,
    );
  });

  it.each([
    "ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID",
    "ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID",
    "ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID",
  ])("requires the reviewed deletion-rehearsal identity pin %s", async (name) => {
    stubAccountDeletionRehearsalEnv({ [name]: "" });

    await expect(loadEnv()).rejects.toThrow(`reviewed permanent-staging Railway identity pins: ${name}`);
  });

  it("requires shared TLS Postgres and rejects every explicit SQLite path for deletion rehearsal", async () => {
    stubAccountDeletionRehearsalEnv({ DATABASE_URL: "" });
    await expect(loadEnv()).rejects.toThrow("DATABASE_URL must be a valid TLS Postgres connection URL");

    stubAccountDeletionRehearsalEnv({
      DATABASE_URL: "postgresql://pintpath_app:fixture-password@postgres.railway.internal:5432/pintpath",
    });
    await expect(loadEnv()).rejects.toThrow("sslmode=require, verify-ca, or verify-full");

    const fragmentedDatabaseUrl = `${accountDeletionRehearsalRequiredEnv.DATABASE_URL}#unexpected-fragment`;
    stubAccountDeletionRehearsalEnv({
      DATABASE_URL: fragmentedDatabaseUrl,
      PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(fragmentedDatabaseUrl),
    });
    await expect(loadEnv()).rejects.toThrow("sslmode=require, verify-ca, or verify-full");

    const ambiguousDatabaseUrl = `${accountDeletionRehearsalRequiredEnv.DATABASE_URL}&sslmode=disable`;
    stubAccountDeletionRehearsalEnv({
      DATABASE_URL: ambiguousDatabaseUrl,
      PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(ambiguousDatabaseUrl),
    });
    await expect(loadEnv()).rejects.toThrow("sslmode=require, verify-ca, or verify-full");

    stubAccountDeletionRehearsalEnv({
      DATABASE_PATH: "/app/data/pint-path.sqlite",
    });
    await expect(loadEnv()).rejects.toThrow("must not configure DATABASE_PATH");
  });

  it("requires evidence that deletion rehearsal is running with at least two Railway replicas", async () => {
    stubAccountDeletionRehearsalEnv({ RAILWAY_REPLICA_ID: "" });
    await expect(loadEnv()).rejects.toThrow("requires RAILWAY_REPLICA_ID");

    stubAccountDeletionRehearsalEnv({
      RAILWAY_REPLICA_ID: "fixture-permanent-staging-replica-a",
      ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT: "1",
    });
    await expect(loadEnv()).rejects.toThrow("ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT>=2");
  });

  it("requires permanent deletion staging to use a Supabase project distinct from production", async () => {
    stubAccountDeletionRehearsalEnv({
      SUPABASE_URL: "https://productionref0000001.supabase.co",
      ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL: "https://productionref0000001.supabase.co",
    });

    await expect(loadEnv()).rejects.toThrow("must be distinct from the comparison-only production project");
  });

  it("rejects leftover deletion-rehearsal pins when the rehearsal flag is off", async () => {
    stubAccountDeletionRehearsalEnv({ ACCOUNT_DELETION_REHEARSAL_ENABLED: "false" });

    await expect(loadEnv()).rejects.toThrow(
      "Account-deletion rehearsal identity/configuration requires ACCOUNT_DELETION_REHEARSAL_ENABLED=true",
    );
  });

  it("rejects weak secrets and insecure transport in ordinary hosted staging", async () => {
    stubStagingBootstrapEnv({
      PUBLIC_BASE_URL: "http://ordinary-staging.up.railway.app",
    });
    await expect(loadEnv()).rejects.toThrow("PUBLIC_BASE_URL must use https://");

    stubStagingBootstrapEnv({
      SOURCE_EVIDENCE_SIGNING_SECRET: "weak",
    });
    await expect(loadEnv()).rejects.toThrow("SOURCE_EVIDENCE_SIGNING_SECRET must be a unique high-entropy secret");
  });

  it("rejects a restore project that reuses production or backup Supabase", async () => {
    stubRestoreRehearsalEnv({ SUPABASE_URL: restoreRehearsalRequiredEnv.RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL });

    await expect(loadEnv()).rejects.toThrow("Supabase identities must match the reviewed disposable restore pin");
  });

  it("rejects Supabase aliases and Redis identities that are not bound to staging", async () => {
    stubRestoreRehearsalEnv({ SUPABASE_URL: "https://auth.pintpath.au" });
    await expect(loadEnv()).rejects.toThrow("canonical HTTPS project origin");

    stubRestoreRehearsalEnv({
      SUPABASE_URL: restoreRehearsalRequiredEnv.SUPABASE_URL,
      RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID: "production",
    });
    await expect(loadEnv()).rejects.toThrow("must be a Railway reference to the current staging environment ID");

    stubRestoreRehearsalEnv({
      RESTORE_REHEARSAL_REDIS_SERVICE_ID: "wrong-restore-redis-service",
    });
    await expect(loadEnv()).rejects.toThrow("match the reviewed disposable Redis service pin");

    stubRestoreRehearsalEnv({ REDIS_URL: "redis://default:fixture-password@production-redis.example:6379" });
    await expect(loadEnv()).rejects.toThrow("redis.railway.internal:6379");
  });

  it("rejects wrong-role or normalized restore service keys without emitting them", async () => {
    for (const candidate of [
      stagingPublishableKey,
      legacyAnonKey,
      legacyServiceRoleKey,
      ` ${stagingServiceKey}`,
      `${stagingServiceKey} `,
      `${stagingServiceKey}\nmalformed`,
      "arbitrary-restore-service-key",
    ]) {
      vi.unstubAllEnvs();
      stubRestoreRehearsalEnv({ SUPABASE_SERVICE_ROLE_KEY: candidate });
      const error = await loadEnv().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "SUPABASE_SERVICE_ROLE_KEY must be an exact sb_secret_ key in production",
      );
      expect((error as Error).message).not.toContain(candidate);
    }
  });

  it("rejects a legacy anon key in the hosted restore rehearsal", async () => {
    stubRestoreRehearsalEnv({ SUPABASE_ANON_KEY: legacyAnonKey });

    await expect(loadEnv()).rejects.toThrow(
      "SUPABASE_ANON_KEY must be an exact sb_publishable_ key in production",
    );
  });

  it("rejects restore mode outside the reviewed disposable Railway project and service", async () => {
    stubRestoreRehearsalEnv({ RAILWAY_PROJECT_ID: "wrong-restore-project" });
    await expect(loadEnv()).rejects.toThrow("RAILWAY_PROJECT_ID");

    stubRestoreRehearsalEnv({ RAILWAY_SERVICE_ID: "wrong-restore-service" });
    await expect(loadEnv()).rejects.toThrow("RAILWAY_SERVICE_ID");
  });

  it("accepts bootstrap only with the inert bootstrap paths", async () => {
    stubRestoreRehearsalEnv({
      RESTORE_REHEARSAL_PHASE: "bootstrap",
      DATABASE_PATH: "/app/data/bootstrap/pint-path.sqlite",
      SOURCE_EVIDENCE_STORAGE_DIR: "/app/data/bootstrap/source-evidence",
    });
    const { env } = await loadEnv();
    expect(env.RESTORE_REHEARSAL_PHASE).toBe("bootstrap");
  });

  it("rejects external-write credentials and non-volume database paths in restore mode", async () => {
    stubRestoreRehearsalEnv({ RESEND_API_KEY: "re_fixture_should_be_rejected" });
    await expect(loadEnv()).rejects.toThrow("prohibits external-write credentials: RESEND_API_KEY");

    stubRestoreRehearsalEnv({
      RESEND_API_KEY: "",
      DATABASE_PATH: "/tmp/pint-path.sqlite",
      SOURCE_EVIDENCE_STORAGE_DIR: "/tmp/source-evidence",
    });
    await expect(loadEnv()).rejects.toThrow(
      "Active restore DATABASE_PATH must exactly match",
    );
  });

  it("rejects admin, smoke, discovery, and operator write surfaces in restore mode", async () => {
    stubRestoreRehearsalEnv({ ADMIN_EMAILS: "admin@example.com" });
    await expect(loadEnv()).rejects.toThrow("external-write credentials: ADMIN_EMAILS");

    stubRestoreRehearsalEnv({
      ADMIN_EMAILS: "",
      PINTPATH_SMOKE_USER_PASSWORD: "fixture-password-that-must-never-reach-restore",
    });
    await expect(loadEnv()).rejects.toThrow("PINTPATH_SMOKE_USER_PASSWORD");

    stubRestoreRehearsalEnv({
      ADMIN_EMAILS: "",
      PINTPATH_SMOKE_USER_PASSWORD: "",
      PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS: "true",
    });
    await expect(loadEnv()).rejects.toThrow(
      "prohibits write-enabling flags: PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS",
    );

    stubRestoreRehearsalEnv({
      COMMERCIAL_LAUNCH_ENABLED: "true",
    });
    await expect(loadEnv()).rejects.toThrow(
      "prohibits write-enabling flags: COMMERCIAL_LAUNCH_ENABLED",
    );

    stubRestoreRehearsalEnv({
      CONSUMER_PAID_ENROLLMENT_ENABLED: "true",
    });
    await expect(loadEnv()).rejects.toThrow(
      "prohibits write-enabling flags: CONSUMER_PAID_ENROLLMENT_ENABLED",
    );

    stubRestoreRehearsalEnv({
      ADMIN_EMAILS: "",
      PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS: "false",
      FIELD_TEST_MODE: "true",
    });
    await expect(loadEnv()).rejects.toThrow("requires field-test mode off");
  });

  it("keeps production identity requirements fail-closed in restore mode", async () => {
    stubRestoreRehearsalEnv({ REQUIRE_ADMIN_MFA_IN_PRODUCTION: "false" });
    await expect(loadEnv()).rejects.toThrow("requires field-test mode off");

    stubRestoreRehearsalEnv({
      REQUIRE_ADMIN_MFA_IN_PRODUCTION: "true",
      REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: "false",
    });
    await expect(loadEnv()).rejects.toThrow("requires field-test mode off");
  });

  it("gates paid-plan, optional POS, and report variables in provider readiness", () => {
    const readinessScript = fs.readFileSync(path.resolve(process.cwd(), "scripts/provider-readiness-check.ts"), "utf8");
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(readinessScript).toContain("const paidEnrollmentEnabled");
    expect(readinessScript).toContain('"STRIPE_PRICE_MONTHLY"');
    expect(readinessScript).toContain('"STRIPE_PRICE_YEARLY"');
    const deferredCredentialsCheck = readinessScript.slice(
      readinessScript.indexOf("const freeLaunchDeferredCredentialsCheck"),
      readinessScript.indexOf("const productionPostgresCheck"),
    );
    expect(deferredCredentialsCheck).not.toBe("");
    expect(deferredCredentialsCheck).toContain('"NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"');
    expect(readinessScript).toContain('checkRequired("GOOGLE_PLACES_API_KEY"');
    expect(readinessScript).toContain('checkRequired("OPENAI_API_KEY"');
    expect(readinessScript).toContain('checkSupabaseKeyFormat("SUPABASE_SERVICE_ROLE_KEY", "secret"');
    expect(readinessScript).toContain('checkExactSupabaseOrigin("OFFSITE_BACKUP_SUPABASE_URL"');
    expect(readinessScript).toContain('checkSupabaseKeyFormat("OFFSITE_BACKUP_SERVICE_ROLE_KEY", "secret"');
    expect(readinessScript).toContain("Private operational restore-copy URL");
    expect(readinessScript).toContain("separately prove WORM authority");
    expect(readinessScript).not.toContain("Independent off-site backup destination");
    expect(readinessScript).toContain("requireNoBucketSizeLimit: true");
    expect(readinessScript).toContain("probeReadWrite: true");
    expect(readinessScript).toContain('"application/pdf"');
    expect(readinessScript).toContain('checkOptionalStrongSecret(\n  "POS_WEBHOOK_SIGNING_SECRET"');
    expect(readinessScript).toContain("SUPABASE_PROVIDER_CALLBACK_URL");
    expect(readinessScript).toContain("/auth/v1/callback");
    expect(readinessScript).toContain("ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION");
    expect(readinessScript).toContain("REQUIRE_ADMIN_MFA_IN_PRODUCTION");
    expect(readinessScript).toContain("OFFSITE_BACKUP_BUCKET");
    expect(readinessScript).toContain("RESEND_API_KEY");
    expect(readinessScript).toContain("REPORT_EMAIL_FROM");
    expect(readinessScript).toContain("REPORT_DELIVERY_SCHEDULE_ENABLED");
    expect(readinessScript).toContain("LAUNCH_READINESS_STRICT");
    expect(readinessScript).toContain("blockingWarnings");
    expect(packageJson.scripts["readiness:launch"]).toContain("LAUNCH_READINESS_STRICT=true NODE_ENV=production");
  });
});
