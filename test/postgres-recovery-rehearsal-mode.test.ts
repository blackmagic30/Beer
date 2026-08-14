import crypto from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
  TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
} from "./postgres-railway-stock-localhost-ca.fixtures.js";

const CANDIDATE = "a".repeat(40);
const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const SERVICE = "33333333-3333-4333-8333-333333333333";
const PRODUCTION_PROJECT = "44444444-4444-4444-8444-444444444444";
const PRODUCTION_ENVIRONMENT = "55555555-5555-4555-8555-555555555555";
const PRODUCTION_SERVICE = "66666666-6666-4666-8666-666666666666";
const STAGING_PROJECT = "77777777-7777-4777-8777-777777777777";
const STAGING_ENVIRONMENT = "88888888-8888-4888-8888-888888888888";
const STAGING_SERVICE = "99999999-9999-4999-8999-999999999999";
const DATABASE_SERVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REDIS_SERVICE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRODUCTION_DATABASE_SERVICE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PRODUCTION_REDIS_SERVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STAGING_DATABASE_SERVICE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const STAGING_REDIS_SERVICE = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const PUBLISHABLE = `sb_publishable_${"r".repeat(32)}`;
const RUNTIME_URL = "postgresql://runtime:runtime-password@postgres-recovery.railway.internal:5432/pintpath?sslmode=verify-full";
const MAINTENANCE_URL = "postgresql://maintenance:maintenance-password@postgres-recovery.railway.internal:5432/pintpath?sslmode=verify-full";
const REDIS_URL = "redis://default:redis-password@redis-recovery.railway.internal:6379";
const PRODUCTION_DATABASE_DIGEST = "1".repeat(64);
const STAGING_DATABASE_DIGEST = "2".repeat(64);
const PRODUCTION_REDIS_DIGEST = "3".repeat(64);
const STAGING_REDIS_DIGEST = "4".repeat(64);

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fixture(overrides: Record<string, string> = {}): Record<string, string> {
  const databaseResource = `railway:${ENVIRONMENT}:${DATABASE_SERVICE}`;
  const redisResource = `railway:${ENVIRONMENT}:${REDIS_SERVICE}`;
  const productionDatabaseResource =
    `railway:${PRODUCTION_ENVIRONMENT}:${PRODUCTION_DATABASE_SERVICE}`;
  const productionRedisResource =
    `railway:${PRODUCTION_ENVIRONMENT}:${PRODUCTION_REDIS_SERVICE}`;
  const stagingDatabaseResource =
    `railway:${STAGING_ENVIRONMENT}:${STAGING_DATABASE_SERVICE}`;
  const stagingRedisResource =
    `railway:${STAGING_ENVIRONMENT}:${STAGING_REDIS_SERVICE}`;
  return {
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "43117",
    PUBLIC_BASE_URL: "http://127.0.0.1:43117",
    TRUST_PROXY_HOPS: "0",
    DATABASE_PATH: "",
    POSTGRES_RECOVERY_REHEARSAL_MODE: "true",
    POSTGRES_RECOVERY_CANDIDATE_SHA: CANDIDATE,
    POSTGRES_RECOVERY_EXPECTED_RAILWAY_PROJECT_ID: PROJECT,
    POSTGRES_RECOVERY_EXPECTED_RAILWAY_ENVIRONMENT_ID: ENVIRONMENT,
    POSTGRES_RECOVERY_EXPECTED_RAILWAY_SERVICE_ID: SERVICE,
    POSTGRES_RECOVERY_PRODUCTION_RAILWAY_PROJECT_ID: PRODUCTION_PROJECT,
    POSTGRES_RECOVERY_PRODUCTION_RAILWAY_ENVIRONMENT_ID: PRODUCTION_ENVIRONMENT,
    POSTGRES_RECOVERY_PRODUCTION_RAILWAY_SERVICE_ID: PRODUCTION_SERVICE,
    POSTGRES_RECOVERY_EXPECTED_SUPABASE_URL: SUPABASE_URL,
    POSTGRES_RECOVERY_EXPECTED_SUPABASE_PUBLISHABLE_KEY_SHA256: hash(PUBLISHABLE),
    POSTGRES_RECOVERY_PRODUCTION_SUPABASE_PUBLISHABLE_KEY_SHA256:
      hash("production-publishable-key"),
    POSTGRES_RECOVERY_PERMANENT_STAGING_SUPABASE_PUBLISHABLE_KEY_SHA256:
      hash("staging-publishable-key"),
    POSTGRES_RECOVERY_EXPECTED_MAINTENANCE_URL_SHA256: hash(MAINTENANCE_URL),
    POSTGRES_RECOVERY_REDIS_SENTINEL: "recovery-redis-sentinel-secret-32-bytes",
    POSTGRES_RECOVERY_PRODUCTION_DATABASE_RESOURCE_ID: productionDatabaseResource,
    POSTGRES_RECOVERY_PRODUCTION_DATABASE_URL_SHA256: PRODUCTION_DATABASE_DIGEST,
    POSTGRES_RECOVERY_PRODUCTION_REDIS_RESOURCE_ID: productionRedisResource,
    POSTGRES_RECOVERY_PRODUCTION_REDIS_URL_SHA256: PRODUCTION_REDIS_DIGEST,
    RAILWAY_GIT_COMMIT_SHA: CANDIDATE,
    RAILWAY_PROJECT_ID: PROJECT,
    RAILWAY_ENVIRONMENT_ID: ENVIRONMENT,
    RAILWAY_SERVICE_ID: SERVICE,
    PINTPATH_IDENTITY_REGISTRY_PHASE: "complete",
    PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID: STAGING_PROJECT,
    PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID: STAGING_ENVIRONMENT,
    PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID: STAGING_SERVICE,
    DATABASE_URL: RUNTIME_URL,
    DATABASE_MAINTENANCE_URL: MAINTENANCE_URL, // security-scan allow: synthetic test-only connection fixture
    PINTPATH_POSTGRES_ROOT_CA_PEM: TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
    PINTPATH_POSTGRES_ROOT_CA_DER_SHA256: TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
    PINTPATH_DATABASE_RESOURCE_ID: databaseResource,
    PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: databaseResource,
    PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS:
      `${productionDatabaseResource},${stagingDatabaseResource}`,
    PINTPATH_EXPECTED_DATABASE_URL_SHA256: hash(RUNTIME_URL),
    PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S:
      `${PRODUCTION_DATABASE_DIGEST},${STAGING_DATABASE_DIGEST}`,
    PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: stagingDatabaseResource,
    PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: STAGING_DATABASE_DIGEST,
    REDIS_URL,
    PINTPATH_REDIS_RESOURCE_ID: redisResource,
    PINTPATH_EXPECTED_REDIS_RESOURCE_ID: redisResource,
    PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS:
      `${productionRedisResource},${stagingRedisResource}`,
    PINTPATH_EXPECTED_REDIS_URL_SHA256: hash(REDIS_URL),
    PINTPATH_FORBIDDEN_REDIS_URL_SHA256S:
      `${PRODUCTION_REDIS_DIGEST},${STAGING_REDIS_DIGEST}`,
    PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: stagingRedisResource,
    PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256: STAGING_REDIS_DIGEST,
    REDIS_KEY_NAMESPACE: `pint-path:postgres-recovery:${ENVIRONMENT}:${CANDIDATE}`,
    REQUIRE_REDIS_RATE_LIMITING: "true",
    ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: "false",
    SUPABASE_URL,
    SUPABASE_ANON_KEY: PUBLISHABLE,
    SUPABASE_SERVICE_ROLE_KEY: "",
    SUPABASE_OAUTH_PROVIDERS: "",
    SOURCE_EVIDENCE_SIGNING_SECRET: "recovery-evidence-signing-secret-32-bytes",
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
    OFFSITE_BACKUP_SUPABASE_URL: "",
    OFFSITE_BACKUP_SERVICE_ROLE_KEY: "",
    GOOGLE_MAPS_API_KEY: "",
    GOOGLE_MAPS_MAP_ID: "",
    GOOGLE_PLACES_API_KEY: "",
    OPENAI_API_KEY: "",
    RESEND_API_KEY: "",
    RESEND_TRANSACTIONAL_API_KEY: "",
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    POS_WEBHOOK_SIGNING_SECRET: "",
    ADMIN_EMAILS: "",
    ...overrides,
  };
}

async function load(overrides: Record<string, string> = {}) {
  for (const [name, value] of Object.entries(fixture(overrides))) vi.stubEnv(name, value);
  vi.resetModules();
  return import("../src/config/env.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("PostgreSQL recovery rehearsal environment", () => {
  it("boots only the explicit loopback Postgres recovery mode", async () => {
    const { env } = await load();
    expect(env.POSTGRES_RECOVERY_REHEARSAL_MODE).toBe(true);
    expect(env.RESTORE_REHEARSAL_MODE).toBe(false);
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.DATABASE_URL).toBe(RUNTIME_URL);
    expect(env.DATABASE_MAINTENANCE_URL).toBe(MAINTENANCE_URL);
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(env.OFFSITE_BACKUP_SUPABASE_URL).toBeUndefined();
  });

  it("rejects production Railway identity or credentials", async () => {
    await expect(load({
      POSTGRES_RECOVERY_EXPECTED_RAILWAY_PROJECT_ID: PRODUCTION_PROJECT,
      RAILWAY_PROJECT_ID: PRODUCTION_PROJECT,
    })).rejects.toThrow("distinct reviewed production Railway identity tuple");

    vi.unstubAllEnvs();
    await expect(load({
      SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(32)}`,
    })).rejects.toThrow("prohibits external-write or elevated credentials");

    vi.unstubAllEnvs();
    const productionKey = `sb_publishable_${"p".repeat(32)}`;
    await expect(load({
      SUPABASE_ANON_KEY: productionKey,
      POSTGRES_RECOVERY_EXPECTED_SUPABASE_PUBLISHABLE_KEY_SHA256:
        hash(productionKey),
      POSTGRES_RECOVERY_PRODUCTION_SUPABASE_PUBLISHABLE_KEY_SHA256:
        hash(productionKey),
    })).rejects.toThrow("publishable-key pin distinct from production");
  });

  it("rejects runtime/maintenance URL reuse and inherited provider writers", async () => {
    await expect(load({
      DATABASE_MAINTENANCE_URL: RUNTIME_URL, // security-scan allow: synthetic adversarial URL-reuse fixture
      POSTGRES_RECOVERY_EXPECTED_MAINTENANCE_URL_SHA256: hash(RUNTIME_URL),
    })).rejects.toThrow("dedicated maintenance login distinct");

    vi.unstubAllEnvs();
    await expect(load({ REPORT_DELIVERY_SCHEDULE_ENABLED: "true" }))
      .rejects.toThrow("inert Free feature scope");
  });

  it("rejects recovery markers unless the distinct mode is enabled", async () => {
    await expect(load({ POSTGRES_RECOVERY_REHEARSAL_MODE: "false" }))
      .rejects.toThrow("requires POSTGRES_RECOVERY_REHEARSAL_MODE=true");
  });
});
