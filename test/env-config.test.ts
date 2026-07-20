import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const productionRequiredEnv = {
  NODE_ENV: "production",
  PUBLIC_BASE_URL: "https://pintpath.au",
  ADMIN_EMAILS: "admin@example.com",
  GOOGLE_MAPS_API_KEY: "test-browser-maps-key",
  GOOGLE_MAPS_MAP_ID: "test-vector-map-id",
  GOOGLE_PLACES_API_KEY: "fixture-google-places-key",
  OPENAI_API_KEY: "test-fixture-not-a-real-menu-key",
  SOURCE_EVIDENCE_SIGNING_SECRET: "test-source-evidence-signing-secret-32-bytes",
  POS_WEBHOOK_SIGNING_SECRET: "test-pos-webhook-signing-secret-32-bytes",
  SUPABASE_URL: "https://production-project.supabase.co",
  SUPABASE_ANON_KEY: "fixture-supabase-browser-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-production-service-role",
  OFFSITE_BACKUP_SUPABASE_URL: "https://independent-backup-project.supabase.co",
  OFFSITE_BACKUP_SERVICE_ROLE_KEY: "test-independent-service-role",
  REDIS_URL: "redis://localhost:6379",
  REQUIRE_REDIS_RATE_LIMITING: "false",
  DEMO_BILLING_MODE: "",
  ALLOW_DEMO_BILLING_IN_PRODUCTION: "false",
  STRIPE_SECRET_KEY: "test-fixture-not-a-real-stripe-key",
  STRIPE_WEBHOOK_SECRET: "test-fixture-not-a-real-webhook-secret",
  STRIPE_PRICE_MONTHLY: "fixture-monthly-price-id",
  STRIPE_PRICE_YEARLY: "fixture-yearly-price-id",
  STRIPE_PRO_PRICE_ID: "fixture-venue-pro-price-id",
};

const restoreRehearsalRequiredEnv = {
  ...productionRequiredEnv,
  RAILWAY_ENVIRONMENT_NAME: "staging",
  RAILWAY_ENVIRONMENT_ID: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  RAILWAY_PROJECT_ID: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  RAILWAY_SERVICE_ID: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
  RAILWAY_VOLUME_MOUNT_PATH: "/app/data",
  RAILWAY_PUBLIC_DOMAIN: "beer-staging.up.railway.app",
  RESTORE_REHEARSAL_MODE: "true",
  RESTORE_REHEARSAL_PHASE: "active",
  RESTORE_REHEARSAL_BACKUP_ID: "pint-path-fixture-backup",
  RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256: "a".repeat(64),
  RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256: "b".repeat(64),
  RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL: "https://jxpubqlmqnnqwadmjgyk.supabase.co",
  RESTORE_REHEARSAL_BACKUP_SUPABASE_URL: "https://gjjffexmflwtnewtkkiy.supabase.co",
  RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  RESTORE_REHEARSAL_REDIS_SERVICE_ID: "d6351cec-fe04-4a6f-8e05-1cc164ea1e73",
  RESTORE_REHEARSAL_REDIS_SENTINEL: "fixture-redis-sentinel-secret-32-bytes",
  RESTORE_REHEARSAL_ACCESS_USERNAME: "restore-operator",
  RESTORE_REHEARSAL_ACCESS_PASSWORD: "fixture-restore-access-password-32-bytes",
  PUBLIC_BASE_URL: "https://beer-staging.up.railway.app",
  DATABASE_PATH: "/app/data/restore-pint-path-fixture-backup/pint-path.sqlite",
  SOURCE_EVIDENCE_STORAGE_DIR: "/app/data/restore-pint-path-fixture-backup/source-evidence",
  SUPABASE_URL: "https://ibveugyfyzjptyvautlr.supabase.co",
  SUPABASE_ANON_KEY: "fixture-restore-staging-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-restore-staging-service-key",
  SUPABASE_OAUTH_PROVIDERS: "",
  REDIS_URL: "redis://default:fixture-password@redis.railway.internal:6379",
  REDIS_KEY_NAMESPACE: "pint-path:restore:a4e0f507-d6d3-4df9-a818-ad92c0071a35:pint-path-fixture-backup",
  REQUIRE_REDIS_RATE_LIMITING: "true",
  REPORT_EMAIL_MODE: "disabled",
  REPORT_DELIVERY_SCHEDULE_ENABLED: "false",
  RESEND_API_KEY: "",
  REPORT_EMAIL_FROM: "",
  REPORT_EMAIL_REPLY_TO: "",
  OFFSITE_BACKUP_SUPABASE_URL: "",
  OFFSITE_BACKUP_SERVICE_ROLE_KEY: "",
  DEMO_BILLING_MODE: "false",
  ALLOW_DEMO_BILLING_IN_PRODUCTION: "false",
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
  });

  it("keeps real monthly report delivery and scheduling disabled by default", async () => {
    stubProductionEnv();

    const { env } = await loadEnv();

    expect(env.REPORT_EMAIL_MODE).toBe("disabled");
    expect(env.REPORT_DELIVERY_SCHEDULE_ENABLED).toBe(false);
    expect(env.REPORT_DELIVERY_DAY).toBe(2);
    expect(env.REPORT_DELIVERY_HOUR).toBe(9);
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

  it("still lets production boot without Redis unless in-memory fallback is explicitly enabled", async () => {
    stubProductionEnv({
      ADMIN_EMAILS: "",
      DEMO_BILLING_MODE: "",
      REDIS_URL: "",
    });

    const { env } = await loadEnv();

    expect(env.NODE_ENV).toBe("production");
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.REQUIRE_REDIS_RATE_LIMITING).toBe(false);
    expect(env.ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION).toBe(false);
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
      `missing required independent off-site backup environment ${expectedLabel}: ${expectedVariables}`,
    );
    expect(message).toContain(`Configure ${expectedReference} in the production service environment and redeploy.`);
    expect(message).toContain("must point to a different project/provider than SUPABASE_URL");
    expect(message).not.toContain(productionRequiredEnv.OFFSITE_BACKUP_SERVICE_ROLE_KEY);
  });

  it("rejects an off-site backup destination that resolves to the production Supabase origin", async () => {
    stubProductionEnv({
      OFFSITE_BACKUP_SUPABASE_URL: "HTTPS://PRODUCTION-PROJECT.SUPABASE.CO/backup/",
    });

    await expect(loadEnv()).rejects.toThrow(
      "OFFSITE_BACKUP_SUPABASE_URL must identify an independent project/provider",
    );
  });

  it("still blocks explicit production demo billing without the override", async () => {
    stubProductionEnv({ DEMO_BILLING_MODE: "true" });

    await expect(loadEnv()).rejects.toThrow(
      "DEMO_BILLING_MODE cannot be true in production unless ALLOW_DEMO_BILLING_IN_PRODUCTION=true.",
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

  it("rejects Railway preview domains as the canonical production public URL", async () => {
    stubProductionEnv({ PUBLIC_BASE_URL: "https://beer-production-aad4.up.railway.app" });

    await expect(loadEnv()).rejects.toThrow(
      "PUBLIC_BASE_URL must be https://pintpath.au in production",
    );
  });

  it("accepts only a fully isolated Railway staging restore rehearsal", async () => {
    stubRestoreRehearsalEnv();

    const { env } = await loadEnv();

    expect(env.RESTORE_REHEARSAL_MODE).toBe(true);
    expect(env.PUBLIC_BASE_URL).toBe("https://beer-staging.up.railway.app");
    expect(env.DATABASE_PATH).toBe("/app/data/restore-pint-path-fixture-backup/pint-path.sqlite");
    expect(env.OFFSITE_BACKUP_SUPABASE_URL).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("fails closed when the restore mode flag is disabled but restore-shaped configuration remains", async () => {
    stubRestoreRehearsalEnv({ RESTORE_REHEARSAL_MODE: "false" });

    await expect(loadEnv()).rejects.toThrow("Restore-shaped configuration or volume contents require");
  });

  it("allows a clean ordinary Railway staging runtime while retaining production transport and secret checks", async () => {
    stubProductionEnv({
      RAILWAY_ENVIRONMENT_NAME: "staging",
      RAILWAY_ENVIRONMENT_ID: "ordinary-staging-environment",
      PUBLIC_BASE_URL: "https://ordinary-staging.up.railway.app",
      RESTORE_REHEARSAL_MODE: "false",
    });

    const { env } = await loadEnv();
    expect(env.RESTORE_REHEARSAL_MODE).toBe(false);
    expect(env.PUBLIC_BASE_URL).toBe("https://ordinary-staging.up.railway.app");
  });

  it("rejects weak secrets and insecure transport in ordinary hosted staging", async () => {
    stubProductionEnv({
      RAILWAY_ENVIRONMENT_NAME: "staging",
      PUBLIC_BASE_URL: "http://ordinary-staging.up.railway.app",
    });
    await expect(loadEnv()).rejects.toThrow("PUBLIC_BASE_URL must use https://");

    stubProductionEnv({
      RAILWAY_ENVIRONMENT_NAME: "staging",
      PUBLIC_BASE_URL: "https://ordinary-staging.up.railway.app",
      SOURCE_EVIDENCE_SIGNING_SECRET: "weak",
    });
    await expect(loadEnv()).rejects.toThrow("SOURCE_EVIDENCE_SIGNING_SECRET must be a unique high-entropy secret");
  });

  it("rejects a restore project that reuses production or backup Supabase", async () => {
    stubRestoreRehearsalEnv({ SUPABASE_URL: restoreRehearsalRequiredEnv.RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL });

    await expect(loadEnv()).rejects.toThrow("Supabase identities must exactly match");
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
      RESTORE_REHEARSAL_REDIS_SERVICE_ID: "00000000-0000-0000-0000-000000000000",
    });
    await expect(loadEnv()).rejects.toThrow("immutable staging Redis Railway service ID");

    stubRestoreRehearsalEnv({ REDIS_URL: "redis://default:fixture-password@production-redis.example:6379" });
    await expect(loadEnv()).rejects.toThrow("redis.railway.internal:6379");
  });

  it("rejects restore mode outside the immutable Railway project and Beer service", async () => {
    stubRestoreRehearsalEnv({ RAILWAY_PROJECT_ID: "00000000-0000-0000-0000-000000000000" });
    await expect(loadEnv()).rejects.toThrow("immutable Pint Path Railway project ID");

    stubRestoreRehearsalEnv({ RAILWAY_SERVICE_ID: "00000000-0000-0000-0000-000000000000" });
    await expect(loadEnv()).rejects.toThrow("immutable staging Beer Railway service ID");
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

  it("checks all paid-plan and POS launch variables in provider readiness", () => {
    const readinessScript = fs.readFileSync(path.resolve(process.cwd(), "scripts/provider-readiness-check.ts"), "utf8");
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(readinessScript).toContain('checkRequired("STRIPE_PRICE_MONTHLY"');
    expect(readinessScript).toContain('checkRequired("STRIPE_PRICE_YEARLY"');
    expect(readinessScript).not.toContain("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY");
    expect(readinessScript).toContain('checkRequired("GOOGLE_PLACES_API_KEY"');
    expect(readinessScript).toContain('checkRequired("OPENAI_API_KEY"');
    expect(readinessScript).toContain('checkRequired("SUPABASE_SERVICE_ROLE_KEY"');
    expect(readinessScript).toContain('checkRequired("OFFSITE_BACKUP_SUPABASE_URL"');
    expect(readinessScript).toContain('checkRequired("OFFSITE_BACKUP_SERVICE_ROLE_KEY"');
    expect(readinessScript).toContain("requireNoBucketSizeLimit: true");
    expect(readinessScript).toContain("probeReadWrite: true");
    expect(readinessScript).toContain('"application/pdf"');
    expect(readinessScript).toContain('checkRequired("POS_WEBHOOK_SIGNING_SECRET"');
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
