import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

interface ReadinessPayload {
  ok: boolean;
  readinessProfile: string;
  checks: Array<{ id: string; status: string; details?: string | null }>;
  summary: { blockingWarnings: number; failures: number };
}

function providerReadinessEnvironment(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "production",
    LAUNCH_READINESS_STRICT: "true",
    ACCOUNT_DELETION_REHEARSAL_ENABLED: "false",
    RESTORE_REHEARSAL_MODE: "false",
    PINTPATH_IDENTITY_REGISTRY_PHASE: "complete",
    DATABASE_PATH: "",
    REDIS_URL: "",
    PINTPATH_EXPECTED_DATABASE_URL_SHA256: "",
    PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: "",
    PINTPATH_DATABASE_RESOURCE_ID: "",
    PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: "",
    PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: "",
    PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: "",
    PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: "",
    PINTPATH_EXPECTED_REDIS_URL_SHA256: "",
    PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: "",
    PINTPATH_REDIS_RESOURCE_ID: "",
    PINTPATH_EXPECTED_REDIS_RESOURCE_ID: "",
    PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: "",
    PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256: "",
    PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: "",
    PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID: "",
    PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID: "",
    PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID: "",
    COMMERCIAL_LAUNCH_ENABLED: "false",
    CONSUMER_PAID_ENROLLMENT_ENABLED: "false",
    VENUE_PRO_TRIAL_DAYS: "0",
    VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD: "false",
    PINT_POINTS_REWARDS_ENABLED: "false",
    ALCOHOL_GAMIFICATION_ENABLED: "false",
    FIELD_TEST_MODE: "false",
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    STRIPE_PRICE_MONTHLY: "",
    STRIPE_PRICE_YEARLY: "",
    STRIPE_PRO_PRICE_ID: "",
    POS_WEBHOOK_SIGNING_SECRET: "",
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "",
    REPORT_EMAIL_MODE: "disabled",
    REPORT_DELIVERY_SCHEDULE_ENABLED: "false",
    PINTPATH_REPORT_DELIVER: "false",
    REPORT_TIMEZONE: "",
    RESEND_API_KEY: "",
    REPORT_EMAIL_FROM: "",
    REPORT_EMAIL_REPLY_TO: "",
    DEMO_BILLING_MODE: "false",
    ALLOW_DEMO_BILLING_IN_PRODUCTION: "false",
    REQUIRE_REDIS_RATE_LIMITING: "true",
    ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: "false",
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    OFFSITE_BACKUP_SUPABASE_URL: "",
    OFFSITE_BACKUP_SERVICE_ROLE_KEY: "",
    ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID: "",
    ACCOUNT_DELETION_NOTICE_KEYRING_JSON: "",
    ...overrides,
  };
}

function runProviderReadiness(overrides: Record<string, string> = {}): ReadinessPayload {
  const result = spawnSync(
    path.resolve("node_modules/.bin/tsx"),
    ["scripts/provider-readiness-check.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: providerReadinessEnvironment(overrides),
    },
  );

  expect(result.stdout).not.toBe("");
  return JSON.parse(result.stdout) as ReadinessPayload;
}

const productionDatabaseUrl = "postgresql://app:fixture@production-db.internal:5432/pintpath?sslmode=require";
const productionRedisUrl = "redis://default:fixture@production-redis.internal:6379";
const stagingDatabaseUrl = "postgresql://app:fixture@staging-db.internal:5432/pintpath?sslmode=require";
const stagingRedisUrl = "redis://default:fixture@staging-redis.internal:6379";
const productionEnvironmentId = "env-production-71b26d90";
const stagingEnvironmentId = "env-staging-40e62ca1";
const restoreEnvironmentId = "env-restore-5a821e3c";
const productionDatabaseResource = `railway:${productionEnvironmentId}:svc-postgres-1d829a`;
const stagingDatabaseResource = `railway:${stagingEnvironmentId}:svc-postgres-1d829a`;
const restoreDatabaseResource = `railway:${restoreEnvironmentId}:svc-postgres-1d829a`;
const productionRedisResource = `railway:${productionEnvironmentId}:svc-redis-4ac109`;
const stagingRedisResource = `railway:${stagingEnvironmentId}:svc-redis-4ac109`;
const restoreRedisResource = `railway:${restoreEnvironmentId}:svc-redis-4ac109`;

function productionIdentityOverrides(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: productionDatabaseUrl,
    REDIS_URL: productionRedisUrl,
    PINTPATH_IDENTITY_REGISTRY_PHASE: "complete",
    PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(productionDatabaseUrl),
    PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${sha256(stagingDatabaseUrl)},${sha256("restore-database-url")}`,
    PINTPATH_DATABASE_RESOURCE_ID: productionDatabaseResource,
    PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: productionDatabaseResource,
    PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: `${stagingDatabaseResource},${restoreDatabaseResource}`,
    PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: sha256(stagingDatabaseUrl),
    PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: stagingDatabaseResource,
    PINTPATH_EXPECTED_REDIS_URL_SHA256: sha256(productionRedisUrl),
    PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: `${sha256(stagingRedisUrl)},${sha256("restore-redis-url")}`,
    PINTPATH_REDIS_RESOURCE_ID: productionRedisResource,
    PINTPATH_EXPECTED_REDIS_RESOURCE_ID: productionRedisResource,
    PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: `${stagingRedisResource},${restoreRedisResource}`,
    PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256: sha256(stagingRedisUrl),
    PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: stagingRedisResource,
    ...overrides,
  };
}

function deletionRehearsalOverrides(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ACCOUNT_DELETION_REHEARSAL_ENABLED: "true",
    PINTPATH_IDENTITY_REGISTRY_PHASE: "complete",
    RAILWAY_ENVIRONMENT_NAME: "staging",
    RAILWAY_PROJECT_ID: "project-pintpath-4af98c",
    RAILWAY_ENVIRONMENT_ID: stagingEnvironmentId,
    RAILWAY_SERVICE_ID: "svc-pintpath-app-92d01b",
    RAILWAY_REPLICA_ID: "replica-staging-a-18c209",
    PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID: "project-pintpath-4af98c",
    PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID: stagingEnvironmentId,
    PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID: "svc-pintpath-app-92d01b",
    ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID: "project-pintpath-4af98c",
    ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID: stagingEnvironmentId,
    ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID: "svc-pintpath-app-92d01b",
    ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT: "2",
    RAILWAY_PUBLIC_DOMAIN: "pintpath-permanent-staging.example.test",
    PUBLIC_BASE_URL: "https://pintpath-permanent-staging.example.test",
    DATABASE_URL: stagingDatabaseUrl,
    PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(stagingDatabaseUrl),
    PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${sha256(productionDatabaseUrl)},${sha256("restore-database-url")}`,
    PINTPATH_DATABASE_RESOURCE_ID: stagingDatabaseResource,
    PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: stagingDatabaseResource,
    PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: `${productionDatabaseResource},${restoreDatabaseResource}`,
    PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: sha256(stagingDatabaseUrl),
    PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: stagingDatabaseResource,
    DATABASE_PATH: "",
    SOURCE_EVIDENCE_SIGNING_SECRET: "staging-source-evidence-signing-secret-32-bytes",
    SUPABASE_URL: "https://fixture-staging.supabase.co",
    ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL: "https://fixture-staging.supabase.co",
    ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL: "https://fixture-production.supabase.co",
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
    REDIS_URL: stagingRedisUrl,
    PINTPATH_EXPECTED_REDIS_URL_SHA256: sha256(stagingRedisUrl),
    PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: `${sha256(productionRedisUrl)},${sha256("restore-redis-url")}`,
    PINTPATH_REDIS_RESOURCE_ID: stagingRedisResource,
    PINTPATH_EXPECTED_REDIS_RESOURCE_ID: stagingRedisResource,
    PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: `${productionRedisResource},${restoreRedisResource}`,
    PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256: sha256(stagingRedisUrl),
    PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: stagingRedisResource,
    REDIS_KEY_NAMESPACE: "pintpath:staging:deletion",
    RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID: "",
    RESTORE_REHEARSAL_REDIS_SERVICE_ID: "",
    RESTORE_REHEARSAL_REDIS_SENTINEL: "",
    REQUIRE_REDIS_RATE_LIMITING: "true",
    ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: "false",
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

function stagingBootstrapOverrides(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PINTPATH_IDENTITY_REGISTRY_PHASE: "staging-bootstrap",
    ACCOUNT_DELETION_REHEARSAL_ENABLED: "false",
    RAILWAY_ENVIRONMENT_NAME: "staging",
    RAILWAY_PROJECT_ID: "project-pintpath-4af98c",
    RAILWAY_ENVIRONMENT_ID: stagingEnvironmentId,
    RAILWAY_SERVICE_ID: "svc-pintpath-app-92d01b",
    PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID: "project-pintpath-4af98c",
    PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID: stagingEnvironmentId,
    PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID: "svc-pintpath-app-92d01b",
    DATABASE_URL: stagingDatabaseUrl,
    DATABASE_PATH: "",
    PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(stagingDatabaseUrl),
    PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: "",
    PINTPATH_DATABASE_RESOURCE_ID: stagingDatabaseResource,
    PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: stagingDatabaseResource,
    PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: "",
    PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: sha256(stagingDatabaseUrl),
    PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: stagingDatabaseResource,
    REDIS_URL: stagingRedisUrl,
    PINTPATH_EXPECTED_REDIS_URL_SHA256: sha256(stagingRedisUrl),
    PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: "",
    PINTPATH_REDIS_RESOURCE_ID: stagingRedisResource,
    PINTPATH_EXPECTED_REDIS_RESOURCE_ID: stagingRedisResource,
    PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: "",
    PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256: sha256(stagingRedisUrl),
    PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: stagingRedisResource,
    REQUIRE_REDIS_RATE_LIMITING: "true",
    ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: "false",
    SOURCE_EVIDENCE_SIGNING_SECRET: "staging-bootstrap-source-evidence-47c019cb",
    ACCOUNT_DELETION_NOTICE_MODE: "disabled",
    SUPABASE_URL: "https://must-not-be-contacted.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "must-not-be-used",
    OFFSITE_BACKUP_SUPABASE_URL: "https://also-must-not-be-contacted.invalid",
    OFFSITE_BACKUP_SERVICE_ROLE_KEY: "must-not-be-used",
    ...overrides,
  };
}

function stagingCompleteOverrides(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...stagingBootstrapOverrides(),
    PINTPATH_IDENTITY_REGISTRY_PHASE: "complete",
    PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${sha256(productionDatabaseUrl)},${sha256("restore-database-url")}`,
    PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: `${productionDatabaseResource},${restoreDatabaseResource}`,
    PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: `${sha256(productionRedisUrl)},${sha256("restore-redis-url")}`,
    PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: `${productionRedisResource},${restoreRedisResource}`,
    GOOGLE_MAPS_API_KEY: "fixture-staging-maps-key",
    GOOGLE_MAPS_MAP_ID: "fixture-staging-map-id",
    GOOGLE_PLACES_API_KEY: "fixture-staging-places-key",
    OPENAI_API_KEY: "fixture-staging-openai-key", // security-scan allow: synthetic readiness fixture
    SUPABASE_URL: "https://fixture-staging.supabase.co",
    SUPABASE_ANON_KEY: "fixture-staging-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-staging-service-role-key",
    SUPABASE_OAUTH_PROVIDERS: "google",
    OFFSITE_BACKUP_SUPABASE_URL: "https://fixture-staging-backup.supabase.co",
    OFFSITE_BACKUP_SERVICE_ROLE_KEY: "fixture-staging-backup-service-role-key",
    ADMIN_EMAILS: "staging-admin@example.test",
    REQUIRE_ADMIN_MFA_IN_PRODUCTION: "true",
    ...overrides,
  };
}

function checkStatuses(payload: ReadinessPayload, ids: string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [
    id,
    payload.checks.find((check) => check.id === id)?.status ?? "missing",
  ]));
}

type CanaryCleanupMode = "exact" | "partial" | "noop";

interface StorageProbeListObservation {
  bucketName: string;
  prefix: string;
  remaining: number;
}

interface StorageProbeRemovalObservation {
  bucketName: string;
  requestedPaths: string[];
  returnedPaths: string[];
}

function createStorageProbeHarness(sourceCleanupMode: CanaryCleanupMode) {
  const objectsByBucket = new Map<string, Map<string, {
    bytes: Buffer;
    contentType: string;
  }>>();
  const listObservations: StorageProbeListObservation[] = [];
  const removalObservations: StorageProbeRemovalObservation[] = [];
  const clientCreations: string[] = [];
  const allowedMimeTypes = [
    "application/json",
    "application/octet-stream",
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ];
  const bucketObjects = (bucketName: string) => {
    const existing = objectsByBucket.get(bucketName);
    if (existing) return existing;
    const created = new Map<string, { bytes: Buffer; contentType: string }>();
    objectsByBucket.set(bucketName, created);
    return created;
  };

  const client = {
    storage: {
      getBucket: async (bucketName: string) => ({
        data: {
          id: bucketName,
          name: bucketName,
          public: false,
          file_size_limit: null,
          allowed_mime_types: allowedMimeTypes,
        },
        error: null,
      }),
      from: (bucketName: string) => ({
        upload: async (
          objectPath: string,
          body: Buffer,
          options: { contentType: string },
        ) => {
          bucketObjects(bucketName).set(objectPath, {
            bytes: Buffer.from(body),
            contentType: options.contentType,
          });
          return { data: { path: objectPath }, error: null };
        },
        list: async (prefix: string) => {
          const names = [...bucketObjects(bucketName).keys()]
            .filter((objectPath) => objectPath.startsWith(`${prefix}/`))
            .sort()
            .map((objectPath) => ({
              id: objectPath,
              name: objectPath.slice(prefix.length + 1),
            }));
          listObservations.push({
            bucketName,
            prefix,
            remaining: names.length,
          });
          return { data: names, error: null };
        },
        download: async (objectPath: string) => {
          const object = bucketObjects(bucketName).get(objectPath);
          return object
            ? {
                data: new Blob([new Uint8Array(object.bytes)], {
                  type: object.contentType,
                }),
                error: null,
              }
            : { data: null, error: new Error("not found") };
        },
        remove: async (requestedPaths: string[]) => {
          const cleanupMode = bucketName === "beermap-source-evidence"
            ? sourceCleanupMode
            : "exact";
          const returnedPaths = cleanupMode === "partial"
              ? requestedPaths.slice(0, 1)
              : [...requestedPaths];
          const deletedPaths = cleanupMode === "noop" ? [] : returnedPaths;
          for (const objectPath of deletedPaths) {
            bucketObjects(bucketName).delete(objectPath);
          }
          removalObservations.push({
            bucketName,
            requestedPaths: [...requestedPaths],
            returnedPaths: [...returnedPaths],
          });
          return {
            data: returnedPaths.map((name) => ({ name })),
            error: null,
          };
        },
      }),
    },
  };

  return { client, clientCreations, listObservations, removalObservations };
}

async function runProviderReadinessWithStorageProbe(
  sourceCleanupMode: CanaryCleanupMode,
  environmentOverrides: Record<string, string> = {},
) {
  const harness = createStorageProbeHarness(sourceCleanupMode);
  const previousEnvironment = process.env;
  const logs: string[] = [];
  process.env = providerReadinessEnvironment(stagingCompleteOverrides({
    SUPABASE_URL: "https://source-readiness.supabase.co",
    SUPABASE_ANON_KEY: "fixture-source-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-source-service-role-key",
    SUPABASE_OAUTH_PROVIDERS: "google",
    OFFSITE_BACKUP_SUPABASE_URL: "https://backup-readiness.supabase.co",
    OFFSITE_BACKUP_SERVICE_ROLE_KEY: "fixture-backup-service-role-key",
    RESTORE_REHEARSAL_PHASE: "",
    RESTORE_REHEARSAL_BACKUP_ID: "",
    RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256: "",
    RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256: "",
    RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID: "",
    RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID: "",
    RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID: "",
    RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL: "",
    RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID: "",
    RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL: "",
    RESTORE_REHEARSAL_BACKUP_SUPABASE_URL: "",
    RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID: "",
    RESTORE_REHEARSAL_REDIS_SERVICE_ID: "",
    RESTORE_REHEARSAL_REDIS_SENTINEL: "",
    RESTORE_REHEARSAL_ACCESS_USERNAME: "",
    RESTORE_REHEARSAL_ACCESS_PASSWORD: "",
    REDIS_KEY_NAMESPACE: "",
    ...environmentOverrides,
  }));
  vi.resetModules();
  vi.doMock("../src/lib/supabase-client.js", () => ({
    createServerSupabaseClient: (url: string) => {
      harness.clientCreations.push(url);
      return harness.client;
    },
  }));
  const logSpy = vi.spyOn(console, "log").mockImplementation((value) => {
    logs.push(String(value));
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(
    () => undefined as never,
  );
  try {
    await import("../scripts/provider-readiness-check.js");
    const output = logs.find((entry) => entry.includes('"readinessProfile"'));
    if (!output) throw new Error("provider readiness output missing");
    return {
      payload: JSON.parse(output) as ReadinessPayload,
      ...harness,
    };
  } finally {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    process.env = previousEnvironment;
    vi.doUnmock("../src/lib/supabase-client.js");
    vi.resetModules();
  }
}

describe("provider readiness feature gating", () => {
  it("keeps the privileged source-evidence readiness canary enabled and MIME-scoped", () => {
    const source = fs.readFileSync(
      path.resolve("scripts/provider-readiness-check.ts"),
      "utf8",
    );
    const sourceEvidenceCall = source.match(
      /id: "SOURCE_EVIDENCE_BUCKET"[\s\S]*?\n\s*\}\);/,
    )?.[0] ?? "";
    expect(sourceEvidenceCall).toContain("probeReadWrite: true");
    expect(source).toContain("requiredMimeTypes.has(canary.contentType)");
    expect(source).toContain('contentType: "application/pdf"');
    expect(source).toContain('contentType: "image/jpeg"');
  });

  it("passes the source-evidence probe only after exact cleanup and an empty-prefix re-list", async () => {
    const result = await runProviderReadinessWithStorageProbe("exact");

    expect(checkStatuses(result.payload, ["SOURCE_EVIDENCE_BUCKET"]))
      .toEqual({ SOURCE_EVIDENCE_BUCKET: "pass" });
    const removal = result.removalObservations.find(
      (entry) => entry.bucketName === "beermap-source-evidence",
    );
    expect(removal?.returnedPaths).toEqual(removal?.requestedPaths);
    const lists = result.listObservations.filter(
      (entry) => entry.bucketName === "beermap-source-evidence",
    );
    expect(lists.map((entry) => entry.remaining)).toEqual([2, 0]);
    expect(new Set(lists.map((entry) => entry.prefix)).size).toBe(1);
  });

  it.each(["partial", "noop"] as const)(
    "fails the source-evidence probe when cleanup is a %s removal",
    async (cleanupMode) => {
      const result = await runProviderReadinessWithStorageProbe(cleanupMode);

      expect(checkStatuses(result.payload, ["SOURCE_EVIDENCE_BUCKET"]))
        .toEqual({ SOURCE_EVIDENCE_BUCKET: "fail" });
      const lists = result.listObservations.filter(
        (entry) => entry.bucketName === "beermap-source-evidence",
      );
      expect(lists).toHaveLength(2);
      expect(lists.at(-1)?.remaining).toBeGreaterThan(0);
    },
  );

  it("passes the complete permanent-staging profile with real sibling pins before running both bounded Storage canaries", async () => {
    const result = await runProviderReadinessWithStorageProbe("exact");

    expect(result.payload.readinessProfile).toBe("permanent_staging_complete");
    expect(result.payload.ok).toBe(true);
    expect(result.payload.summary).toEqual(expect.objectContaining({
      failures: 0,
      blockingWarnings: 0,
    }));
    expect(checkStatuses(result.payload, [
      "PERMANENT_STAGING_RAILWAY_IDENTITY",
      "PERMANENT_STAGING_POSTGRES_DATABASE_URL",
      "PERMANENT_STAGING_DATABASE_IDENTITY",
      "PERMANENT_STAGING_DATABASE_RESOURCE_IDENTITY",
      "PERMANENT_STAGING_REDIS_IDENTITY",
      "PERMANENT_STAGING_REDIS_RESOURCE_IDENTITY",
      "PERMANENT_STAGING_SERVICE_INSTANCE_IDENTITIES",
      "PERMANENT_STAGING_NAMED_SELF_PINS",
      "SOURCE_EVIDENCE_BUCKET",
      "OFFSITE_BACKUP_BUCKET",
    ])).toEqual({
      PERMANENT_STAGING_RAILWAY_IDENTITY: "pass",
      PERMANENT_STAGING_POSTGRES_DATABASE_URL: "pass",
      PERMANENT_STAGING_DATABASE_IDENTITY: "pass",
      PERMANENT_STAGING_DATABASE_RESOURCE_IDENTITY: "pass",
      PERMANENT_STAGING_REDIS_IDENTITY: "pass",
      PERMANENT_STAGING_REDIS_RESOURCE_IDENTITY: "pass",
      PERMANENT_STAGING_SERVICE_INSTANCE_IDENTITIES: "pass",
      PERMANENT_STAGING_NAMED_SELF_PINS: "pass",
      SOURCE_EVIDENCE_BUCKET: "pass",
      OFFSITE_BACKUP_BUCKET: "pass",
    });
    expect(result.clientCreations).toHaveLength(2);
  });

  it.each([
    [
      "database URL sibling list contains the staging self digest",
      {
        PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S:
          `${sha256(stagingDatabaseUrl)},${sha256("restore-database-url")}`,
      },
      "PERMANENT_STAGING_DATABASE_IDENTITY",
    ],
    [
      "Redis resource sibling list contains the staging self resource",
      {
        PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS:
          `${stagingRedisResource},${restoreRedisResource}`,
      },
      "PERMANENT_STAGING_REDIS_RESOURCE_IDENTITY",
    ],
  ])("fails complete permanent staging when the %s", (_label, overrides, checkId) => {
    const payload = runProviderReadiness(stagingCompleteOverrides(overrides));

    expect(payload.readinessProfile).toBe("permanent_staging_complete");
    expect(checkStatuses(payload, [checkId])).toEqual({ [checkId]: "fail" });
    expect(checkStatuses(payload, ["PERMANENT_STAGING_NAMED_SELF_PINS"]))
      .toEqual({ PERMANENT_STAGING_NAMED_SELF_PINS: "pass" });
  });

  it.each([
    [
      "database URL sibling",
      { PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: sha256(productionDatabaseUrl) },
      "PERMANENT_STAGING_DATABASE_IDENTITY",
    ],
    [
      "Redis resource sibling",
      { PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: productionRedisResource },
      "PERMANENT_STAGING_REDIS_RESOURCE_IDENTITY",
    ],
  ])("fails complete permanent staging with one missing %s", (_label, overrides, checkId) => {
    const payload = runProviderReadiness(stagingCompleteOverrides(overrides));

    expect(payload.readinessProfile).toBe("permanent_staging_complete");
    expect(checkStatuses(payload, [checkId])).toEqual({ [checkId]: "fail" });
  });

  it("does not construct a Supabase client or run a Storage canary before permanent-staging preflight passes", async () => {
    const result = await runProviderReadinessWithStorageProbe("exact", {
      PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: productionDatabaseResource,
    });

    expect(result.payload.ok).toBe(false);
    expect(checkStatuses(result.payload, ["PERMANENT_STAGING_DATABASE_RESOURCE_IDENTITY"]))
      .toEqual({ PERMANENT_STAGING_DATABASE_RESOURCE_IDENTITY: "fail" });
    expect(result.clientCreations).toEqual([]);
    expect(result.listObservations).toEqual([]);
    expect(result.removalObservations).toEqual([]);
    expect(result.payload.checks.map((check) => check.id)).not.toEqual(
      expect.arrayContaining(["SOURCE_EVIDENCE_BUCKET", "OFFSITE_BACKUP_BUCKET"]),
    );
  });

  it("requires a TLS Postgres DATABASE_URL for the full-scale production profile", () => {
    const missing = runProviderReadiness({ DATABASE_URL: "" });
    const sqlite = runProviderReadiness({ DATABASE_URL: "file:/app/data/pint-path.sqlite" });
    const noTls = runProviderReadiness({
      DATABASE_URL: "postgresql://app:fixture@database.internal:5432/pintpath",
    });
    const valid = runProviderReadiness({
      DATABASE_URL: "postgresql://app:fixture@database.internal:5432/pintpath?sslmode=require",
    });
    const sqlitePathAlsoConfigured = runProviderReadiness({
      DATABASE_URL: "postgresql://app:fixture@database.internal:5432/pintpath?sslmode=require",
      DATABASE_PATH: "/app/data/pint-path.sqlite",
    });
    const fragment = runProviderReadiness({
      DATABASE_URL: "postgresql://app:fixture@database.internal:5432/pintpath?sslmode=require#unexpected-fragment",
    });
    const duplicateSslMode = runProviderReadiness({
      DATABASE_URL: "postgresql://app:fixture@database.internal:5432/pintpath?sslmode=require&sslmode=disable",
    });

    expect(checkStatuses(missing, ["PRODUCTION_POSTGRES_DATABASE_URL"]))
      .toEqual({ PRODUCTION_POSTGRES_DATABASE_URL: "fail" });
    expect(checkStatuses(sqlite, ["PRODUCTION_POSTGRES_DATABASE_URL"]))
      .toEqual({ PRODUCTION_POSTGRES_DATABASE_URL: "fail" });
    expect(checkStatuses(noTls, ["PRODUCTION_POSTGRES_DATABASE_URL"]))
      .toEqual({ PRODUCTION_POSTGRES_DATABASE_URL: "fail" });
    expect(checkStatuses(valid, ["PRODUCTION_POSTGRES_DATABASE_URL"]))
      .toEqual({ PRODUCTION_POSTGRES_DATABASE_URL: "pass" });
    expect(checkStatuses(sqlitePathAlsoConfigured, ["PRODUCTION_POSTGRES_DATABASE_URL"]))
      .toEqual({ PRODUCTION_POSTGRES_DATABASE_URL: "fail" });
    expect(checkStatuses(fragment, ["PRODUCTION_POSTGRES_DATABASE_URL"]))
      .toEqual({ PRODUCTION_POSTGRES_DATABASE_URL: "fail" });
    expect(checkStatuses(duplicateSslMode, ["PRODUCTION_POSTGRES_DATABASE_URL"]))
      .toEqual({ PRODUCTION_POSTGRES_DATABASE_URL: "fail" });
    expect(checkStatuses(valid, ["POSTGRES_RUNTIME_IMPLEMENTATION"]))
      .toEqual({ POSTGRES_RUNTIME_IMPLEMENTATION: "pass" });
  });

  it("pins production database and Redis URLs to reviewed environment digests without emitting credentials", () => {
    const safe = runProviderReadiness(productionIdentityOverrides());
    const databaseAlias = runProviderReadiness(productionIdentityOverrides({
      PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${sha256(productionDatabaseUrl)},${"e".repeat(64)}`,
    }));
    const redisAlias = runProviderReadiness(productionIdentityOverrides({
      PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: `${sha256(productionRedisUrl)},${"f".repeat(64)}`,
    }));

    expect(checkStatuses(safe, [
      "PRODUCTION_DATABASE_IDENTITY",
      "PRODUCTION_DATABASE_RESOURCE_IDENTITY",
      "PRODUCTION_REDIS_IDENTITY",
      "PRODUCTION_REDIS_RESOURCE_IDENTITY",
    ])).toEqual({
      PRODUCTION_DATABASE_IDENTITY: "pass",
      PRODUCTION_DATABASE_RESOURCE_IDENTITY: "pass",
      PRODUCTION_REDIS_IDENTITY: "pass",
      PRODUCTION_REDIS_RESOURCE_IDENTITY: "pass",
    });
    expect(checkStatuses(databaseAlias, ["PRODUCTION_DATABASE_IDENTITY"]))
      .toEqual({ PRODUCTION_DATABASE_IDENTITY: "fail" });
    expect(checkStatuses(redisAlias, ["PRODUCTION_REDIS_IDENTITY"]))
      .toEqual({ PRODUCTION_REDIS_IDENTITY: "fail" });
    expect(JSON.stringify(safe)).not.toContain("fixture@production");
  });

  it.each([
    [
      "one database forbidden URL digest",
      { PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: "a".repeat(64) },
      "PRODUCTION_DATABASE_IDENTITY",
    ],
    [
      "duplicate database forbidden URL digests",
      { PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${"a".repeat(64)},${"a".repeat(64)}` },
      "PRODUCTION_DATABASE_IDENTITY",
    ],
    [
      "one Redis forbidden URL digest",
      { PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: "b".repeat(64) },
      "PRODUCTION_REDIS_IDENTITY",
    ],
    [
      "duplicate Redis forbidden URL digests",
      { PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: `${"b".repeat(64)},${"b".repeat(64)}` },
      "PRODUCTION_REDIS_IDENTITY",
    ],
    [
      "one database forbidden resource ID",
      { PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: stagingDatabaseResource },
      "PRODUCTION_DATABASE_RESOURCE_IDENTITY",
    ],
    [
      "duplicate database forbidden resource IDs",
      { PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: `${stagingDatabaseResource},${stagingDatabaseResource}` },
      "PRODUCTION_DATABASE_RESOURCE_IDENTITY",
    ],
    [
      "one Redis forbidden resource ID",
      { PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: stagingRedisResource },
      "PRODUCTION_REDIS_RESOURCE_IDENTITY",
    ],
    [
      "duplicate Redis forbidden resource IDs",
      { PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: `${stagingRedisResource},${stagingRedisResource}` },
      "PRODUCTION_REDIS_RESOURCE_IDENTITY",
    ],
  ])("fails provider readiness with %s", (_description, overrides, checkId) => {
    const payload = runProviderReadiness(productionIdentityOverrides(overrides));

    expect(checkStatuses(payload, [checkId])).toEqual({ [checkId]: "fail" });
  });

  it("derives the implemented PostgreSQL runtime independently of ignored environment overrides", () => {
    const production = runProviderReadiness({
      DATABASE_URL: "postgresql://app:fixture@database.internal:5432/pintpath?sslmode=require",
      POSTGRES_RUNTIME_IMPLEMENTED: "true",
    });
    const deletion = runProviderReadiness(deletionRehearsalOverrides({
      POSTGRES_RUNTIME_IMPLEMENTED: "true",
    }));

    expect(checkStatuses(production, ["POSTGRES_RUNTIME_IMPLEMENTATION"]))
      .toEqual({ POSTGRES_RUNTIME_IMPLEMENTATION: "pass" });
    expect(checkStatuses(deletion, ["POSTGRES_RUNTIME_IMPLEMENTATION"]))
      .toEqual({ POSTGRES_RUNTIME_IMPLEMENTATION: "pass" });
  });

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
      "FREE_LAUNCH_SCOPE",
      "FREE_LAUNCH_DEFERRED_CREDENTIALS_ABSENT",
    ];

    expect(payload.readinessProfile).toBe("production_free_launch");
    expect(checkStatuses(payload, ids)).toEqual(
      Object.fromEntries(ids.map((id) => [id, "pass"])),
    );
  });

  it.each([
    ["COMMERCIAL_LAUNCH_ENABLED", "true"],
    ["CONSUMER_PAID_ENROLLMENT_ENABLED", "true"],
    ["VENUE_PRO_TRIAL_DAYS", "30"],
    ["VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD", "true"],
    ["PINT_POINTS_REWARDS_ENABLED", "true"],
    ["ALCOHOL_GAMIFICATION_ENABLED", "true"],
    ["FIELD_TEST_MODE", "true"],
    ["REPORT_EMAIL_MODE", "resend"],
    ["REPORT_DELIVERY_SCHEDULE_ENABLED", "true"],
    ["PINTPATH_REPORT_DELIVER", "true"],
    ["DEMO_BILLING_MODE", "true"],
    ["ALLOW_DEMO_BILLING_IN_PRODUCTION", "true"],
    ["REQUIRE_REDIS_RATE_LIMITING", "false"],
    ["ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION", "true"],
  ])("fails the frozen Free-launch scope when %s=%s", (name, value) => {
    const payload = runProviderReadiness({ [name]: value });

    expect(checkStatuses(payload, ["FREE_LAUNCH_SCOPE"]))
      .toEqual({ FREE_LAUNCH_SCOPE: "fail" });
  });

  it.each([
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_MONTHLY",
    "STRIPE_PRICE_YEARLY",
    "STRIPE_PRO_PRICE_ID",
    "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    "POS_WEBHOOK_SIGNING_SECRET",
    "RESEND_API_KEY",
    "REPORT_EMAIL_FROM",
    "REPORT_EMAIL_REPLY_TO",
  ])("fails the frozen Free launch when deferred credential %s is configured", (name) => {
    const payload = runProviderReadiness({ [name]: "configured-but-forbidden-for-this-release" });

    expect(checkStatuses(payload, ["FREE_LAUNCH_DEFERRED_CREDENTIALS_ABSENT"]))
      .toEqual({ FREE_LAUNCH_DEFERRED_CREDENTIALS_ABSENT: "fail" });
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

  it("uses an operator-only staging-bootstrap profile that performs no Storage canary and can never pass launch readiness", () => {
    const payload = runProviderReadiness(stagingBootstrapOverrides());
    const checkIds = payload.checks.map((check) => check.id);

    expect(payload.readinessProfile).toBe("permanent_staging_identity_bootstrap_incomplete");
    expect(payload.ok).toBe(false);
    expect(checkStatuses(payload, [
      "PERMANENT_STAGING_RAILWAY_IDENTITY",
      "PERMANENT_STAGING_BOOTSTRAP_DATABASE_IDENTITY",
      "PERMANENT_STAGING_BOOTSTRAP_DATABASE_RESOURCE",
      "PERMANENT_STAGING_BOOTSTRAP_REDIS_IDENTITY",
      "PERMANENT_STAGING_BOOTSTRAP_REDIS_RESOURCE",
      "PERMANENT_STAGING_SERVICE_INSTANCE_IDENTITIES",
      "PERMANENT_STAGING_NAMED_SELF_PINS",
      "PERMANENT_STAGING_BOOTSTRAP_NOT_CUTOVER_READY",
    ])).toEqual({
      PERMANENT_STAGING_RAILWAY_IDENTITY: "pass",
      PERMANENT_STAGING_BOOTSTRAP_DATABASE_IDENTITY: "pass",
      PERMANENT_STAGING_BOOTSTRAP_DATABASE_RESOURCE: "pass",
      PERMANENT_STAGING_BOOTSTRAP_REDIS_IDENTITY: "pass",
      PERMANENT_STAGING_BOOTSTRAP_REDIS_RESOURCE: "pass",
      PERMANENT_STAGING_SERVICE_INSTANCE_IDENTITIES: "pass",
      PERMANENT_STAGING_NAMED_SELF_PINS: "pass",
      PERMANENT_STAGING_BOOTSTRAP_NOT_CUTOVER_READY: "fail",
    });
    expect(checkIds).not.toEqual(expect.arrayContaining([
      "SOURCE_EVIDENCE_BUCKET",
      "OFFSITE_BACKUP_BUCKET",
      "OFFSITE_BACKUP_OPERATIONAL_COPY_DISTINCT",
    ]));
  });

  it.each([
    ["wrong Railway tuple", { RAILWAY_ENVIRONMENT_ID: productionEnvironmentId }, "PERMANENT_STAGING_RAILWAY_IDENTITY"],
    ["premature database sibling", { PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: productionDatabaseResource }, "PERMANENT_STAGING_BOOTSTRAP_DATABASE_RESOURCE"],
    ["placeholder database service", { PINTPATH_DATABASE_RESOURCE_ID: `railway:${stagingEnvironmentId}:fixture-postgres` }, "PERMANENT_STAGING_BOOTSTRAP_DATABASE_RESOURCE"],
    ["shared Redis service ID", { PINTPATH_REDIS_RESOURCE_ID: "svc-redis-4ac109", PINTPATH_EXPECTED_REDIS_RESOURCE_ID: "svc-redis-4ac109", PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: "svc-redis-4ac109" }, "PERMANENT_STAGING_SERVICE_INSTANCE_IDENTITIES"],
  ])("fails staging bootstrap with %s", (_label, overrides, checkId) => {
    const payload = runProviderReadiness(stagingBootstrapOverrides(overrides));

    expect(checkStatuses(payload, [checkId])).toEqual({ [checkId]: "fail" });
  });

  it("uses a notification-scoped, mutation-free readiness profile for deletion rehearsal", () => {
    const payload = runProviderReadiness(deletionRehearsalOverrides());
    const checkIds = payload.checks.map((check) => check.id);

    expect(payload.readinessProfile).toBe("account_deletion_rehearsal");
    expect(payload.ok).toBe(true);
    expect(payload.summary).toEqual(expect.objectContaining({ failures: 0, blockingWarnings: 0 }));
    expect(checkStatuses(payload, ["POSTGRES_RUNTIME_IMPLEMENTATION"]))
      .toEqual({ POSTGRES_RUNTIME_IMPLEMENTATION: "pass" });
    expect(checkStatuses(payload, [
      "ACCOUNT_DELETION_REHEARSAL_RAILWAY_IDENTITY",
      "ACCOUNT_DELETION_REHEARSAL_PUBLIC_ORIGIN",
      "ACCOUNT_DELETION_REHEARSAL_DATABASE",
      "ACCOUNT_DELETION_REHEARSAL_DATABASE_IDENTITY",
      "ACCOUNT_DELETION_REHEARSAL_DATABASE_RESOURCE_IDENTITY",
      "ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT",
      "ACCOUNT_DELETION_REHEARSAL_SUPABASE_IDENTITY",
      "ACCOUNT_DELETION_REHEARSAL_BACKUP_CREDENTIALS_ABSENT",
      "ACCOUNT_DELETION_REHEARSAL_REDIS_ISOLATION",
      "ACCOUNT_DELETION_REHEARSAL_REDIS_IDENTITY",
      "ACCOUNT_DELETION_REHEARSAL_REDIS_RESOURCE_IDENTITY",
      "ACCOUNT_DELETION_NOTICE_MODE",
      "ACCOUNT_DELETION_NOTICE_KEYRING",
      "RESEND_TRANSACTIONAL_API_KEY",
      "RESEND_WEBHOOK_SIGNING_SECRET",
    ])).toEqual({
      ACCOUNT_DELETION_REHEARSAL_RAILWAY_IDENTITY: "pass",
      ACCOUNT_DELETION_REHEARSAL_PUBLIC_ORIGIN: "pass",
      ACCOUNT_DELETION_REHEARSAL_DATABASE: "pass",
      ACCOUNT_DELETION_REHEARSAL_DATABASE_IDENTITY: "pass",
      ACCOUNT_DELETION_REHEARSAL_DATABASE_RESOURCE_IDENTITY: "pass",
      ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT: "pass",
      ACCOUNT_DELETION_REHEARSAL_SUPABASE_IDENTITY: "pass",
      ACCOUNT_DELETION_REHEARSAL_BACKUP_CREDENTIALS_ABSENT: "pass",
      ACCOUNT_DELETION_REHEARSAL_REDIS_ISOLATION: "pass",
      ACCOUNT_DELETION_REHEARSAL_REDIS_IDENTITY: "pass",
      ACCOUNT_DELETION_REHEARSAL_REDIS_RESOURCE_IDENTITY: "pass",
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
    ["missing Redis URL", { REDIS_URL: "" }, "ACCOUNT_DELETION_REHEARSAL_REDIS_ISOLATION"],
    ["production Redis namespace", { REDIS_KEY_NAMESPACE: "pintpath:production:deletion" }, "ACCOUNT_DELETION_REHEARSAL_REDIS_ISOLATION"],
  ])("fails the deletion-rehearsal isolation check when %s is inherited", (_label, overrides, checkId) => {
    const payload = runProviderReadiness(deletionRehearsalOverrides(overrides));

    expect(payload.readinessProfile).toBe("account_deletion_rehearsal");
    expect(payload.ok).toBe(false);
    expect(checkStatuses(payload, [checkId])).toEqual({ [checkId]: "fail" });
    expect(payload.checks.some((check) => check.id === "OFFSITE_BACKUP_BUCKET")).toBe(false);
  });

  it.each([
    ["an expected Railway pin is absent", { ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID: "" }, "ACCOUNT_DELETION_REHEARSAL_RAILWAY_IDENTITY"],
    ["the runtime Railway identity differs", { RAILWAY_SERVICE_ID: "unexpected-service" }, "ACCOUNT_DELETION_REHEARSAL_RAILWAY_IDENTITY"],
    ["SQLite is configured", { DATABASE_PATH: "/app/data/pint-path.sqlite" }, "ACCOUNT_DELETION_REHEARSAL_DATABASE"],
    ["Postgres does not require TLS", { DATABASE_URL: "postgresql://app:fixture@staging-db.internal:5432/pintpath" }, "ACCOUNT_DELETION_REHEARSAL_DATABASE"],
    ["fewer than two replicas are declared", { ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT: "1" }, "ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT"],
    ["no Railway replica identity is present", { RAILWAY_REPLICA_ID: "" }, "ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT"],
    ["staging aliases production Supabase", { ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL: "https://fixture-staging.supabase.co" }, "ACCOUNT_DELETION_REHEARSAL_SUPABASE_IDENTITY"],
  ])("fails the permanent deletion staging profile when %s", (_label, overrides, checkId) => {
    const payload = runProviderReadiness(deletionRehearsalOverrides(overrides));

    expect(payload.readinessProfile).toBe("account_deletion_rehearsal");
    expect(checkStatuses(payload, [checkId])).toEqual({ [checkId]: "fail" });
  });
});
