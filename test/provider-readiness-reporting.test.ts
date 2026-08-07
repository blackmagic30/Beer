import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

interface ReadinessPayload {
  ok: boolean;
  readinessProfile: string;
  checks: Array<{ id: string; status: string; details?: string | null }>;
  summary: { blockingWarnings: number; failures: number };
}

function runProviderReadiness(overrides: Record<string, string> = {}): ReadinessPayload {
  const result = spawnSync(
    path.resolve("node_modules/.bin/tsx"),
    ["scripts/provider-readiness-check.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        LAUNCH_READINESS_STRICT: "true",
        ACCOUNT_DELETION_REHEARSAL_ENABLED: "false",
        COMMERCIAL_LAUNCH_ENABLED: "false",
        CONSUMER_PAID_ENROLLMENT_ENABLED: "false",
        STRIPE_SECRET_KEY: "",
        STRIPE_WEBHOOK_SECRET: "",
        STRIPE_PRICE_MONTHLY: "",
        STRIPE_PRICE_YEARLY: "",
        STRIPE_PRO_PRICE_ID: "",
        POS_WEBHOOK_SIGNING_SECRET: "",
        REPORT_EMAIL_MODE: "disabled",
        REPORT_DELIVERY_SCHEDULE_ENABLED: "false",
        REPORT_TIMEZONE: "",
        RESEND_API_KEY: "",
        REPORT_EMAIL_FROM: "",
        REPORT_EMAIL_REPLY_TO: "",
        SUPABASE_URL: "",
        SUPABASE_ANON_KEY: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
        OFFSITE_BACKUP_SUPABASE_URL: "",
        OFFSITE_BACKUP_SERVICE_ROLE_KEY: "",
        ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID: "",
        ACCOUNT_DELETION_NOTICE_KEYRING_JSON: "",
        ...overrides,
      },
    },
  );

  expect(result.stdout).not.toBe("");
  return JSON.parse(result.stdout) as ReadinessPayload;
}

function deletionRehearsalOverrides(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ACCOUNT_DELETION_REHEARSAL_ENABLED: "true",
    RAILWAY_ENVIRONMENT_NAME: "staging",
    RAILWAY_PROJECT_ID: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
    RAILWAY_ENVIRONMENT_ID: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    RAILWAY_SERVICE_ID: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
    RAILWAY_VOLUME_MOUNT_PATH: "/app/data",
    RAILWAY_PUBLIC_DOMAIN: "beer-staging.up.railway.app",
    PUBLIC_BASE_URL: "https://beer-staging.up.railway.app",
    DATABASE_PATH: "/app/data/pint-path.sqlite",
    SOURCE_EVIDENCE_STORAGE_DIR: "/app/data/source-evidence",
    SOURCE_EVIDENCE_SIGNING_SECRET: "staging-source-evidence-signing-secret-32-bytes",
    SUPABASE_URL: "https://ibveugyfyzjptyvautlr.supabase.co",
    SUPABASE_ANON_KEY: "fixture-deletion-rehearsal-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-deletion-rehearsal-service-role-key",
    SUPABASE_OAUTH_PROVIDERS: "google",
    ACCOUNT_DELETION_NOTICE_MODE: "resend",
    RESEND_TRANSACTIONAL_API_KEY: "re_fixture_staging_deletion_notice",
    ACCOUNT_DELETION_NOTICE_FROM: "Pint Path <account@pintpath.au>",
    ACCOUNT_DELETION_NOTICE_REPLY_TO: "admin@pintpath.au",
    RESEND_WEBHOOK_SIGNING_SECRET: `whsec_${Buffer.alloc(32, 8).toString("base64")}`,
    ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID: "fixture-staging-v1",
    ACCOUNT_DELETION_NOTICE_KEYRING_JSON: JSON.stringify({
      "fixture-staging-v1": Buffer.alloc(32, 7).toString("base64"),
    }),
    ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES: "5",
    OFFSITE_BACKUP_SUPABASE_URL: "",
    OFFSITE_BACKUP_SERVICE_ROLE_KEY: "",
    REDIS_URL: "",
    REDIS_KEY_NAMESPACE: "",
    RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID: "",
    RESTORE_REHEARSAL_REDIS_SERVICE_ID: "",
    RESTORE_REHEARSAL_REDIS_SENTINEL: "",
    REQUIRE_REDIS_RATE_LIMITING: "false",
    ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: "true",
    RESTORE_REHEARSAL_MODE: "false",
    REPORT_EMAIL_MODE: "disabled",
    REPORT_DELIVERY_SCHEDULE_ENABLED: "false",
    DEMO_BILLING_MODE: "false",
    COMMERCIAL_LAUNCH_ENABLED: "false",
    CONSUMER_PAID_ENROLLMENT_ENABLED: "false",
    STRIPE_SECRET_KEY: "",
    ...overrides,
  };
}

function checkStatuses(payload: ReadinessPayload, ids: string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [
    id,
    payload.checks.find((check) => check.id === id)?.status ?? "missing",
  ]));
}

describe("provider readiness feature gating", () => {
  it("passes deferred Stripe, POS, and report checks when their launch features are disabled", () => {
    const payload = runProviderReadiness();
    const ids = [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PRICE_MONTHLY",
      "STRIPE_PRICE_YEARLY",
      "STRIPE_PRO_PRICE_ID",
      "STRIPE_SECRET_KEY_MODE",
      "POS_WEBHOOK_SIGNING_SECRET",
      "REPORT_EMAIL_MODE",
      "REPORT_DELIVERY_SCHEDULE_ENABLED",
      "REPORT_TIMEZONE",
      "RESEND_API_KEY",
      "REPORT_EMAIL_FROM",
    ];

    expect(checkStatuses(payload, ids)).toEqual(
      Object.fromEntries(ids.map((id) => [id, "pass"])),
    );
  });

  it.each([
    "COMMERCIAL_LAUNCH_ENABLED",
    "CONSUMER_PAID_ENROLLMENT_ENABLED",
  ])("fails every missing Stripe requirement when %s is enabled", (flag) => {
    const payload = runProviderReadiness({ [flag]: "true" });

    expect(checkStatuses(payload, [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PRICE_MONTHLY",
      "STRIPE_PRICE_YEARLY",
      "STRIPE_PRO_PRICE_ID",
    ])).toEqual({
      STRIPE_SECRET_KEY: "fail",
      STRIPE_WEBHOOK_SECRET: "fail",
      STRIPE_PRICE_MONTHLY: "fail",
      STRIPE_PRICE_YEARLY: "fail",
      STRIPE_PRO_PRICE_ID: "fail",
    });
  });

  it("requires report credentials only when report delivery is enabled", () => {
    const payload = runProviderReadiness({
      REPORT_EMAIL_MODE: "resend",
      REPORT_TIMEZONE: "Australia/Melbourne",
    });

    expect(checkStatuses(payload, [
      "REPORT_EMAIL_MODE",
      "REPORT_DELIVERY_SCHEDULE_ENABLED",
      "REPORT_TIMEZONE",
      "RESEND_API_KEY",
      "REPORT_EMAIL_FROM",
    ])).toEqual({
      REPORT_EMAIL_MODE: "pass",
      REPORT_DELIVERY_SCHEDULE_ENABLED: "pass",
      REPORT_TIMEZONE: "pass",
      RESEND_API_KEY: "fail",
      REPORT_EMAIL_FROM: "fail",
    });
  });

  it("keeps POS disabled when absent and rejects a configured weak signing secret", () => {
    const disabled = runProviderReadiness();
    const weak = runProviderReadiness({ POS_WEBHOOK_SIGNING_SECRET: "short" });

    expect(checkStatuses(disabled, ["POS_WEBHOOK_SIGNING_SECRET"]))
      .toEqual({ POS_WEBHOOK_SIGNING_SECRET: "pass" });
    expect(checkStatuses(weak, ["POS_WEBHOOK_SIGNING_SECRET"]))
      .toEqual({ POS_WEBHOOK_SIGNING_SECRET: "fail" });
  });

  it("uses a notification-scoped, mutation-free readiness profile for deletion rehearsal", () => {
    const payload = runProviderReadiness(deletionRehearsalOverrides());
    const checkIds = payload.checks.map((check) => check.id);

    expect(payload.readinessProfile).toBe("account_deletion_rehearsal");
    expect(payload.ok).toBe(true);
    expect(payload.summary).toEqual(expect.objectContaining({ failures: 0, blockingWarnings: 0 }));
    expect(checkStatuses(payload, [
      "ACCOUNT_DELETION_REHEARSAL_RAILWAY_IDENTITY",
      "ACCOUNT_DELETION_REHEARSAL_PUBLIC_ORIGIN",
      "ACCOUNT_DELETION_REHEARSAL_LOCAL_PATHS",
      "ACCOUNT_DELETION_REHEARSAL_SUPABASE_IDENTITY",
      "ACCOUNT_DELETION_REHEARSAL_BACKUP_CREDENTIALS_ABSENT",
      "ACCOUNT_DELETION_REHEARSAL_REDIS_ISOLATION",
      "ACCOUNT_DELETION_NOTICE_MODE",
      "ACCOUNT_DELETION_NOTICE_KEYRING",
      "RESEND_TRANSACTIONAL_API_KEY",
      "RESEND_WEBHOOK_SIGNING_SECRET",
    ])).toEqual({
      ACCOUNT_DELETION_REHEARSAL_RAILWAY_IDENTITY: "pass",
      ACCOUNT_DELETION_REHEARSAL_PUBLIC_ORIGIN: "pass",
      ACCOUNT_DELETION_REHEARSAL_LOCAL_PATHS: "pass",
      ACCOUNT_DELETION_REHEARSAL_SUPABASE_IDENTITY: "pass",
      ACCOUNT_DELETION_REHEARSAL_BACKUP_CREDENTIALS_ABSENT: "pass",
      ACCOUNT_DELETION_REHEARSAL_REDIS_ISOLATION: "pass",
      ACCOUNT_DELETION_NOTICE_MODE: "pass",
      ACCOUNT_DELETION_NOTICE_KEYRING: "pass",
      RESEND_TRANSACTIONAL_API_KEY: "pass",
      RESEND_WEBHOOK_SIGNING_SECRET: "pass",
    });
    expect(checkIds).not.toEqual(expect.arrayContaining([
      "OFFSITE_BACKUP_BUCKET",
      "OFFSITE_BACKUP_SUPABASE_URL",
      "GOOGLE_PLACES_API_KEY",
      "OPENAI_API_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "RESEND_API_KEY",
    ]));
  });

  it.each([
    ["backup URL", { OFFSITE_BACKUP_SUPABASE_URL: "https://backup.example.com" }, "ACCOUNT_DELETION_REHEARSAL_BACKUP_CREDENTIALS_ABSENT"],
    ["backup service key", { OFFSITE_BACKUP_SERVICE_ROLE_KEY: "forbidden-backup-key" }, "ACCOUNT_DELETION_REHEARSAL_BACKUP_CREDENTIALS_ABSENT"],
    ["Redis URL", { REDIS_URL: "redis://production-redis.example:6379" }, "ACCOUNT_DELETION_REHEARSAL_REDIS_ISOLATION"],
  ])("fails the deletion-rehearsal isolation check when %s is inherited", (_label, overrides, checkId) => {
    const payload = runProviderReadiness(deletionRehearsalOverrides(overrides));

    expect(payload.readinessProfile).toBe("account_deletion_rehearsal");
    expect(payload.ok).toBe(false);
    expect(checkStatuses(payload, [checkId])).toEqual({ [checkId]: "fail" });
    expect(payload.checks.some((check) => check.id === "OFFSITE_BACKUP_BUCKET")).toBe(false);
  });
});
