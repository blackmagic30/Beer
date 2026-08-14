import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(root, "package.json");
const railwayPath = path.join(root, "railway.toml");
const serverPath = path.join(root, "src/server.ts");
const compiledEnvPath = path.join(root, "dist/src/config/env.js");
const expectedPredeployScript = "NODE_ENV=production node dist/src/config/env.js";
const syntheticRestoreIdentity = Object.freeze({
  railwayEnvironmentId: "fixture-restore-environment",
  railwayProjectId: "fixture-restore-project",
  railwayServiceId: "fixture-restore-app-service",
  railwayPublicDomain: "restore-staging-fixture.up.railway.app",
  redisServiceId: "fixture-restore-redis-service",
  supabaseUrl: "https://restoreref0000000001.supabase.co",
});
const syntheticPermanentStagingSupabaseUrl = "https://bbfibbadwjxzrcdncavy.supabase.co";
const syntheticProductionSupabaseUrl = "https://productionref0000001.supabase.co";
const syntheticBackupSupabaseUrl = "https://hfbmhdxrwtihukmixxta.supabase.co";
const syntheticProductionDatabaseUrl = "postgresql://ci_app:fixture-password@postgres-production.railway.internal:5432/pintpath?sslmode=verify-full";
const syntheticProductionMaintenanceDatabaseUrl = "postgresql://ci_maintenance:fixture-password@postgres-production.railway.internal:5432/pintpath?sslmode=verify-full";
const syntheticProductionRedisUrl = "redis://default:fixture-password@production-redis.internal:6379";
const syntheticStagingDatabaseUrl = "postgresql://ci_app:fixture-password@postgres-staging.railway.internal:5432/pintpath?sslmode=verify-full";
const syntheticStagingMaintenanceDatabaseUrl = "postgresql://ci_maintenance:fixture-password@postgres-staging.railway.internal:5432/pintpath?sslmode=verify-full";
const syntheticStagingRedisUrl = "redis://default:fixture-password@staging-redis.internal:6379";
// Public synthetic test authority shared byte-for-byte with the focused
// Railway stock-localhost transport fixture. Derive the pin from its X.509 DER
// rather than maintaining a second hand-copied digest.
const syntheticPostgresRootCaPem = `-----BEGIN CERTIFICATE-----
MIIDUjCCAjqgAwIBAgIUYBQyRs0suyX5rXqgVNuwjILfVgwwDQYJKoZIhvcNAQEL
BQAwLzEtMCsGA1UEAwwkUGludFBhdGggUmFpbHdheSBUcmFuc3BvcnQgVGVzdCBS
b290MB4XDTI2MDgxMDA1MzYxM1oXDTM2MDgwNzA1MzYxM1owLzEtMCsGA1UEAwwk
UGludFBhdGggUmFpbHdheSBUcmFuc3BvcnQgVGVzdCBSb290MIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzVV9MGHj6Z6rKbzATlt6Bwkh8H5tSoG9tIlI
nHWFdtoQgTft+jGH3gRvow+/r+4KBz+2f3d6lmIXf3Z2W32P3xPCO/A4HA5T+vHb
enNLWRBP/IHDkdPPVCjlXKwOR+cLUczOdd+YaEnDPZeQ+CrPyKgqCLTEBZqTIBWE
tbYwtElDdx/0f0QzbMMWOuP0LV9rnHg18M04yOdBqxGlKyi04mL2rZEoJurSsoeL
xNfeWiVch5Ret5hof3rf088qf02UN+K3d4Uk/1J3XgCCdzoaY6R3H7SqL3FGzsih
uIETTD7olfSz0DtgZ7RPMTEsrShAN5j8kyoR30SxnfQZRbPQdQIDAQABo2YwZDAd
BgNVHQ4EFgQUMrvU9IxE3Rw9I2Lb8Mu8ux8Q9wswHwYDVR0jBBgwFoAUMrvU9IxE
3Rw9I2Lb8Mu8ux8Q9wswEgYDVR0TAQH/BAgwBgEB/wIBATAOBgNVHQ8BAf8EBAMC
AQYwDQYJKoZIhvcNAQELBQADggEBABQBrpqpxBFYyOxryIcitEuRh0DMQWTn7oRE
jYHJJbNRKiyaFzVo5bqamf6Ft5wKXP/CNljUOTpfZa8Y+dY+TrcP197HMhcT0Zwi
F59mL1zAGSG9V1Kj2qDvNOtOeaQavk1G23bs8HU5tx7Bhx9zsZvkI2y//fX+EjCU
ZufpD/15KvvWwUmLXr8nUkZoLUxw1degtHWCPzNT3f+3Jjp4EYU1nQwz8yvxjL7g
EgybrSNRwoBxVF0Dbido1byzyZCn/LSdz817nfPkGynWvl49Bxtwz9nENfOUNCA7
kjqZ5XK0MFWChjgcl8iF0BqOJfAQTS6WltU1HpU29avHR3FEEgQ=
-----END CERTIFICATE-----
`;
const syntheticProductionEnvironmentId = "env-production-71b26d90";
const syntheticStagingEnvironmentId = "env-staging-40e62ca1";
const syntheticRestoreEnvironmentId = "env-restore-5a821e3c";
const productionDatabaseResource = `railway:${syntheticProductionEnvironmentId}:svc-postgres-1d829a`;
const stagingDatabaseResource = `railway:${syntheticStagingEnvironmentId}:svc-postgres-1d829a`;
const restoreDatabaseResource = `railway:${syntheticRestoreEnvironmentId}:svc-postgres-1d829a`;
const productionRedisResource = `railway:${syntheticProductionEnvironmentId}:svc-redis-4ac109`;
const stagingRedisResource = `railway:${syntheticStagingEnvironmentId}:svc-redis-4ac109`;
const restoreRedisResource = `railway:${syntheticRestoreEnvironmentId}:svc-redis-4ac109`;

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

const syntheticPostgresRootCaDerSha256 = crypto
  .createHash("sha256")
  .update(new crypto.X509Certificate(syntheticPostgresRootCaPem).raw)
  .digest("hex");

function legacySupabaseJwt(role, signatureByte) {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8")
      .toString("base64url"),
    Buffer.from(JSON.stringify({
      iss: "supabase",
      ref: `deploy-guard-${signatureByte}`,
      role,
      iat: 1_700_000_000,
      exp: 2_000_000_000,
    }), "utf8").toString("base64url"),
    Buffer.alloc(32, signatureByte).toString("base64url"),
  ].join(".");
}

const productionLegacyAnonKey = legacySupabaseJwt("anon", 1);
const productionLegacyServiceRoleKey = legacySupabaseJwt("service_role", 2);
const productionLegacyOffsiteServiceRoleKey = legacySupabaseJwt("service_role", 3);
const productionPublishableKey = `sb_publishable_${"a".repeat(32)}`;
const productionServiceKey = `sb_secret_${"b".repeat(32)}`;
const productionOffsiteServiceKey = `sb_secret_${"c".repeat(32)}`;
const restorePublishableKey = `sb_publishable_${"r".repeat(32)}`;
const restoreServiceKey = `sb_secret_${"t".repeat(32)}`;
const stagingPublishableKey = `sb_publishable_${"p".repeat(32)}`;
const stagingServiceKey = `sb_secret_${"s".repeat(32)}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
assert(
  packageJson.scripts?.["predeploy:production"] === expectedPredeployScript,
  `package.json must keep predeploy:production set to: ${expectedPredeployScript}`,
);

const railwayConfig = readFileSync(railwayPath, "utf8");
const deploySection = railwayConfig.match(/(?:^|\n)\[deploy\]\s*\n([\s\S]*?)(?=\n\[[^\]]+\]|$)/)?.[1] ?? "";
assert(
  /^preDeployCommand\s*=\s*\[\s*"npm run predeploy:production"\s*\]\s*$/m.test(deploySection),
  "railway.toml must run npm run predeploy:production from deploy.preDeployCommand.",
);
assert(
  existsSync(compiledEnvPath),
  "dist/src/config/env.js is missing. Run npm run build before checking the production deploy guard.",
);
const serverSource = readFileSync(serverPath, "utf8");
assert(
  serverSource.indexOf("assertApplicationServerStartAllowed();") >= 0
    && serverSource.indexOf("assertApplicationServerStartAllowed();") < serverSource.indexOf('import("./app.js")'),
  "src/server.ts must reject staging-bootstrap before importing the app, routes, or workers.",
);

const productionFixture = {
  NODE_ENV: "production",
  RAILWAY_ENVIRONMENT_NAME: "production",
  RAILWAY_ENVIRONMENT_ID: syntheticProductionEnvironmentId,
  RAILWAY_PROJECT_ID: "project-pintpath-4af98c",
  RAILWAY_SERVICE_ID: "svc-pintpath-app-92d01b",
  PUBLIC_BASE_URL: "https://pintpath.au",
  DATABASE_URL: syntheticProductionDatabaseUrl,
  DATABASE_MAINTENANCE_URL: syntheticProductionMaintenanceDatabaseUrl, // security-scan allow: synthetic deploy-guard fixture
  PINTPATH_POSTGRES_ROOT_CA_PEM: syntheticPostgresRootCaPem,
  PINTPATH_POSTGRES_ROOT_CA_DER_SHA256: syntheticPostgresRootCaDerSha256,
  DATABASE_PATH: "",
  PINTPATH_IDENTITY_REGISTRY_PHASE: "complete",
  PINTPATH_DATABASE_RESOURCE_ID: productionDatabaseResource,
  PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: productionDatabaseResource,
  PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: `${stagingDatabaseResource},${restoreDatabaseResource}`,
  PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(syntheticProductionDatabaseUrl),
  PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${sha256(syntheticStagingDatabaseUrl)},${sha256("restore-database-url")}`,
  PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: stagingDatabaseResource,
  PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: sha256(syntheticStagingDatabaseUrl),
  REDIS_URL: syntheticProductionRedisUrl,
  PINTPATH_REDIS_RESOURCE_ID: productionRedisResource,
  PINTPATH_EXPECTED_REDIS_RESOURCE_ID: productionRedisResource,
  PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: `${stagingRedisResource},${restoreRedisResource}`,
  PINTPATH_EXPECTED_REDIS_URL_SHA256: sha256(syntheticProductionRedisUrl),
  PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: `${sha256(syntheticStagingRedisUrl)},${sha256("restore-redis-url")}`,
  PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: stagingRedisResource,
  PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256: sha256(syntheticStagingRedisUrl),
  REQUIRE_REDIS_RATE_LIMITING: "true",
  ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: "false",
  PORT: "3000",
  GOOGLE_MAPS_API_KEY: "ci-maps-browser-key",
  GOOGLE_MAPS_MAP_ID: "ci-vector-map-id",
  GOOGLE_PLACES_API_KEY: "ci-places-server-key",
  OPENAI_API_KEY: "ci-menu-extraction-key", // security-scan allow: synthetic deploy-guard fixture
  SUPABASE_URL: "https://auth.pintpath.au",
  SUPABASE_ANON_KEY: productionPublishableKey,
  SUPABASE_SERVICE_ROLE_KEY: productionServiceKey,
  SUPABASE_OAUTH_PROVIDERS: "google",
  OFFSITE_BACKUP_SUPABASE_URL: syntheticBackupSupabaseUrl,
  OFFSITE_BACKUP_SERVICE_ROLE_KEY: productionOffsiteServiceKey,
  SOURCE_EVIDENCE_SIGNING_SECRET: "ci-source-5cb42f19-629e-47c3-9be4-7e52127ce22d",
  POS_WEBHOOK_SIGNING_SECRET: "ci-pos-78f01954-bfd3-457e-a8cf-28c5b35cbe13",
  DEMO_BILLING_MODE: "false",
  STRIPE_SECRET_KEY: "ci-stripe-server-key", // security-scan allow: synthetic deploy-guard fixture
  STRIPE_WEBHOOK_SECRET: "ci-stripe-webhook-key", // security-scan allow: synthetic deploy-guard fixture
  STRIPE_PRICE_MONTHLY: "ci-monthly-price",
  STRIPE_PRICE_YEARLY: "ci-yearly-price",
  STRIPE_PRO_PRICE_ID: "ci-pro-price",
  REPORT_EMAIL_MODE: "disabled",
  REPORT_DELIVERY_SCHEDULE_ENABLED: "false",
  ACCOUNT_DELETION_NOTICE_MODE: "resend",
  RESEND_TRANSACTIONAL_API_KEY: "ci-account-deletion-sending-key", // security-scan allow: synthetic deploy-guard fixture
  ACCOUNT_DELETION_NOTICE_FROM: "Pint Path <account@pintpath.au>",
  ACCOUNT_DELETION_NOTICE_REPLY_TO: "admin@pintpath.au",
  RESEND_WEBHOOK_SIGNING_SECRET: "whsec_cXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXE=", // security-scan allow: synthetic deploy-guard fixture
  ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID: "ci-2026-08",
  ACCOUNT_DELETION_NOTICE_KEYRING_JSON:
    '{"ci-2026-08":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}',
  ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES: "5",
};

const restoreRehearsalFixture = {
  NODE_ENV: "production",
  PINTPATH_IDENTITY_REGISTRY_PHASE: "complete",
  RAILWAY_ENVIRONMENT_NAME: "staging",
  RAILWAY_ENVIRONMENT_ID: syntheticRestoreIdentity.railwayEnvironmentId,
  RAILWAY_PROJECT_ID: syntheticRestoreIdentity.railwayProjectId,
  RAILWAY_SERVICE_ID: syntheticRestoreIdentity.railwayServiceId,
  RAILWAY_VOLUME_MOUNT_PATH: "/app/data",
  RAILWAY_PUBLIC_DOMAIN: syntheticRestoreIdentity.railwayPublicDomain,
  RESTORE_REHEARSAL_MODE: "true",
  RESTORE_REHEARSAL_PHASE: "active",
  RESTORE_REHEARSAL_BACKUP_ID: "pint-path-ci-backup",
  RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID: syntheticRestoreIdentity.railwayEnvironmentId,
  RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID: syntheticRestoreIdentity.railwayProjectId,
  RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID: syntheticRestoreIdentity.railwayServiceId,
  RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL: syntheticRestoreIdentity.supabaseUrl,
  RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID: syntheticRestoreIdentity.redisServiceId,
  RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL: syntheticProductionSupabaseUrl,
  RESTORE_REHEARSAL_BACKUP_SUPABASE_URL: syntheticBackupSupabaseUrl,
  RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID: syntheticRestoreIdentity.railwayEnvironmentId,
  RESTORE_REHEARSAL_REDIS_SERVICE_ID: syntheticRestoreIdentity.redisServiceId,
  RESTORE_REHEARSAL_REDIS_SENTINEL: "ci-restore-redis-sentinel-42fbe92a-2f56",
  RESTORE_REHEARSAL_ACCESS_USERNAME: "restore-operator",
  RESTORE_REHEARSAL_ACCESS_PASSWORD: "ci-restore-access-1cd92e0a-784f-4f21",
  PUBLIC_BASE_URL: `https://${syntheticRestoreIdentity.railwayPublicDomain}`,
  DATABASE_PATH: "/app/data/restore-pint-path-ci-backup/pint-path.sqlite",
  PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: `${stagingDatabaseResource},${productionDatabaseResource}`,
  PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${sha256(syntheticStagingDatabaseUrl)},${sha256(syntheticProductionDatabaseUrl)}`,
  PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: stagingDatabaseResource,
  PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: sha256(syntheticStagingDatabaseUrl),
  SOURCE_EVIDENCE_STORAGE_DIR: "/app/data/restore-pint-path-ci-backup/source-evidence",
  GOOGLE_MAPS_API_KEY: "ci-staging-origin-restricted-maps-key",
  GOOGLE_MAPS_MAP_ID: "ci-staging-vector-map-id",
  GOOGLE_PLACES_API_KEY: "",
  OPENAI_API_KEY: "",
  SUPABASE_URL: syntheticRestoreIdentity.supabaseUrl,
  SUPABASE_ANON_KEY: restorePublishableKey,
  SUPABASE_SERVICE_ROLE_KEY: restoreServiceKey,
  SUPABASE_OAUTH_PROVIDERS: "",
  OFFSITE_BACKUP_SUPABASE_URL: "",
  OFFSITE_BACKUP_SERVICE_ROLE_KEY: "",
  SOURCE_EVIDENCE_SIGNING_SECRET: "ci-restore-source-bb07c1be-75cf-4ec8-b8f6",
  POS_WEBHOOK_SIGNING_SECRET: "",
  REDIS_URL: "redis://default:fixture-password@redis.railway.internal:6379",
  PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: `${stagingRedisResource},${productionRedisResource}`,
  PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: `${sha256(syntheticStagingRedisUrl)},${sha256(syntheticProductionRedisUrl)}`,
  PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: stagingRedisResource,
  PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256: sha256(syntheticStagingRedisUrl),
  REDIS_KEY_NAMESPACE: `pint-path:restore:${syntheticRestoreIdentity.railwayEnvironmentId}:pint-path-ci-backup`,
  REQUIRE_REDIS_RATE_LIMITING: "true",
  DEMO_BILLING_MODE: "false",
  ALLOW_DEMO_BILLING_IN_PRODUCTION: "false",
  ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: "false",
  STRIPE_SECRET_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  STRIPE_PRICE_MONTHLY: "",
  STRIPE_PRICE_YEARLY: "",
  STRIPE_PRO_PRICE_ID: "",
  REPORT_EMAIL_MODE: "disabled",
  REPORT_EMAIL_FROM: "",
  REPORT_EMAIL_REPLY_TO: "",
  RESEND_API_KEY: "",
  REPORT_DELIVERY_SCHEDULE_ENABLED: "false",
  ACCOUNT_DELETION_NOTICE_MODE: "disabled",
  RESEND_TRANSACTIONAL_API_KEY: "",
  ACCOUNT_DELETION_NOTICE_FROM: "",
  ACCOUNT_DELETION_NOTICE_REPLY_TO: "",
  RESEND_WEBHOOK_SIGNING_SECRET: "",
  ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID: "",
  ACCOUNT_DELETION_NOTICE_KEYRING_JSON: "",
  ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES: "5",
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
  FIELD_TEST_MODE: "false",
  REQUIRE_ADMIN_MFA_IN_PRODUCTION: "true",
  REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: "true",
};

function runValidator({ fixture = productionFixture, overrides = {}, unset = [] } = {}) {
  const env = { ...process.env, ...fixture, ...overrides };
  for (const name of unset) delete env[name];
  return spawnSync(process.execPath, [compiledEnvPath], {
    cwd: tmpdir(),
    env,
    encoding: "utf8",
  });
}

function assertExit(result, expectedSuccess, label) {
  const succeeded = result.status === 0;
  if (succeeded === expectedSuccess) return;
  const diagnostic = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim().slice(-2_000);
  throw new Error(`${label} ${expectedSuccess ? "failed" : "unexpectedly passed"}.${diagnostic ? `\n${diagnostic}` : ""}`);
}

assertExit(runValidator(), true, "Complete production environment validation");
for (const [variable, verifiedUrl] of [
  ["DATABASE_URL", syntheticProductionDatabaseUrl],
  ["DATABASE_MAINTENANCE_URL", syntheticProductionMaintenanceDatabaseUrl],
]) {
  const requireUrl = verifiedUrl.replace(
    "sslmode=verify-full",
    "sslmode=require",
  );
  assertExit(
    runValidator({
      overrides: {
        [variable]: requireUrl,
        ...(variable === "DATABASE_URL"
          ? { PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(requireUrl) }
          : {}),
      },
    }),
    false,
    `Production validation with ${variable} sslmode=require`,
  );
}
for (const variable of [
  "PINTPATH_POSTGRES_ROOT_CA_PEM",
  "PINTPATH_POSTGRES_ROOT_CA_DER_SHA256",
]) {
  assertExit(
    runValidator({ unset: [variable] }),
    false,
    `Production validation without authenticated Postgres CA ${variable}`,
  );
}
assertExit(
  runValidator({
    overrides: { PINTPATH_POSTGRES_ROOT_CA_DER_SHA256: "0".repeat(64) },
  }),
  false,
  "Production validation with a mismatched Postgres root CA DER pin",
);
for (const candidate of [
  "https://attacker.invalid",
  "https://production-ci.supabase.co",
  "http://auth.pintpath.au",
  "https://auth.pintpath.au/",
  "https://user@auth.pintpath.au",
  "https://auth.pintpath.au:443",
  "https://auth.pintpath.au/path",
  "https://auth.pintpath.au?source=production",
  "https://auth.pintpath.au#fragment",
  " https://auth.pintpath.au",
]) {
  assertExit(
    runValidator({ overrides: { SUPABASE_URL: candidate } }),
    false,
    "Production validation with a noncanonical Supabase origin",
  );
}
for (const [label, candidate] of [
  ["secret-shaped public key", `sb_secret_${"x".repeat(32)}`],
  ["malformed publishable key", `sb_publishable_${"x".repeat(19)}`],
  ["arbitrary legacy-like public key", "ci-browser-safe-key"],
  ["legacy anon key", productionLegacyAnonKey],
  ["legacy service-role key in the public slot", productionLegacyServiceRoleKey],
]) {
  assertExit(
    runValidator({ overrides: { SUPABASE_ANON_KEY: candidate } }),
    false,
    `Production validation with ${label}`,
  );
}
assertExit(
  runValidator({ overrides: { SUPABASE_SERVICE_ROLE_KEY: productionLegacyAnonKey } }),
  false,
  "Production validation with an anon JWT in the primary service slot",
);
assertExit(
  runValidator({ overrides: { SUPABASE_SERVICE_ROLE_KEY: productionLegacyServiceRoleKey } }),
  false,
  "Production validation with a legacy service-role JWT in the primary service slot",
);
assertExit(
  runValidator({ overrides: { OFFSITE_BACKUP_SERVICE_ROLE_KEY: productionLegacyAnonKey } }),
  false,
  "Production validation with an anon JWT in the off-site service slot",
);
assertExit(
  runValidator({ overrides: { OFFSITE_BACKUP_SERVICE_ROLE_KEY: productionLegacyOffsiteServiceRoleKey } }),
  false,
  "Production validation with a legacy service-role JWT in the off-site service slot",
);
for (const nodeEnv of ["", "development"]) {
  assertExit(
    runValidator({ overrides: { NODE_ENV: nodeEnv } }),
    false,
    `Hosted production validation with NODE_ENV=${nodeEnv || "unset"}`,
  );
}

for (const variable of [
  "DATABASE_URL",
  "PINTPATH_DATABASE_RESOURCE_ID",
  "PINTPATH_EXPECTED_DATABASE_RESOURCE_ID",
  "PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS",
  "PINTPATH_EXPECTED_DATABASE_URL_SHA256",
  "PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S",
  "PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID",
  "PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256",
  "REDIS_URL",
  "PINTPATH_REDIS_RESOURCE_ID",
  "PINTPATH_EXPECTED_REDIS_RESOURCE_ID",
  "PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS",
  "PINTPATH_EXPECTED_REDIS_URL_SHA256",
  "PINTPATH_FORBIDDEN_REDIS_URL_SHA256S",
  "PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID",
  "PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256",
]) {
  assertExit(
    runValidator({ unset: [variable] }),
    false,
    `Production validation without connection identity ${variable}`,
  );
}

for (const variable of ["OFFSITE_BACKUP_SUPABASE_URL", "OFFSITE_BACKUP_SERVICE_ROLE_KEY"]) {
  assertExit(
    runValidator({ unset: [variable] }),
    false,
    `Production validation without ${variable}`,
  );
}

assertExit(
  runValidator({ overrides: { OFFSITE_BACKUP_SUPABASE_URL: productionFixture.SUPABASE_URL } }),
  false,
  "Production validation with a non-independent backup destination",
);

assertExit(
  runValidator({ fixture: restoreRehearsalFixture }),
  true,
  "Complete restore rehearsal environment validation",
);
assertExit(
  runValidator({
    fixture: restoreRehearsalFixture,
    overrides: { SUPABASE_ANON_KEY: productionLegacyAnonKey },
  }),
  false,
  "Restore validation with a legacy anon JWT",
);
assertExit(
  runValidator({
    fixture: restoreRehearsalFixture,
    overrides: { SUPABASE_SERVICE_ROLE_KEY: productionLegacyServiceRoleKey },
  }),
  false,
  "Restore validation with a legacy service-role JWT",
);
for (const variable of [
  "RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID",
  "RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID",
  "RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID",
  "RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL",
  "RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID",
  "PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS",
  "PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S",
  "PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID",
  "PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256",
  "PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS",
  "PINTPATH_FORBIDDEN_REDIS_URL_SHA256S",
  "PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID",
  "PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256",
]) {
  assertExit(
    runValidator({ fixture: restoreRehearsalFixture, unset: [variable] }),
    false,
    `Restore validation without protected pin ${variable}`,
  );
}
assertExit(
  runValidator({ fixture: restoreRehearsalFixture, overrides: { RESTORE_REHEARSAL_MODE: "false" } }),
  false,
  "Restore-shaped staging validation with restore rehearsal mode disabled",
);
const ordinaryStagingFixture = {
  NODE_ENV: "production",
  RAILWAY_ENVIRONMENT_NAME: "staging",
  RAILWAY_ENVIRONMENT_ID: syntheticStagingEnvironmentId,
  RAILWAY_PROJECT_ID: "project-pintpath-4af98c",
  RAILWAY_SERVICE_ID: "svc-pintpath-app-92d01b",
  PUBLIC_BASE_URL: "https://ordinary-staging.up.railway.app",
  PINTPATH_IDENTITY_REGISTRY_PHASE: "staging-bootstrap",
  PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID: syntheticStagingEnvironmentId,
  PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID: "project-pintpath-4af98c",
  PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID: "svc-pintpath-app-92d01b",
  DATABASE_URL: syntheticStagingDatabaseUrl,
  DATABASE_MAINTENANCE_URL: syntheticStagingMaintenanceDatabaseUrl, // security-scan allow: synthetic deploy-guard fixture
  PINTPATH_POSTGRES_ROOT_CA_PEM: syntheticPostgresRootCaPem,
  PINTPATH_POSTGRES_ROOT_CA_DER_SHA256: syntheticPostgresRootCaDerSha256,
  DATABASE_PATH: "",
  PINTPATH_DATABASE_RESOURCE_ID: stagingDatabaseResource,
  PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: stagingDatabaseResource,
  PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: "",
  PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(syntheticStagingDatabaseUrl),
  PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: "",
  PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: stagingDatabaseResource,
  PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: sha256(syntheticStagingDatabaseUrl),
  REDIS_URL: syntheticStagingRedisUrl,
  PINTPATH_REDIS_RESOURCE_ID: stagingRedisResource,
  PINTPATH_EXPECTED_REDIS_RESOURCE_ID: stagingRedisResource,
  PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: "",
  PINTPATH_EXPECTED_REDIS_URL_SHA256: sha256(syntheticStagingRedisUrl),
  PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: "",
  PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: stagingRedisResource,
  PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256: sha256(syntheticStagingRedisUrl),
  REDIS_KEY_NAMESPACE: "pintpath:permanent-staging-bootstrap",
  REQUIRE_REDIS_RATE_LIMITING: "true",
  ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: "false",
  SUPABASE_URL: syntheticPermanentStagingSupabaseUrl,
  SUPABASE_ANON_KEY: stagingPublishableKey,
  SUPABASE_SERVICE_ROLE_KEY: stagingServiceKey,
  SOURCE_EVIDENCE_SIGNING_SECRET: "ci-staging-source-bf644d2c-401c-493b-b590",
  POS_WEBHOOK_SIGNING_SECRET: "ci-staging-pos-f71ed34d-c2dd-4175-bda0",
  DEMO_BILLING_MODE: "false",
  ACCOUNT_DELETION_NOTICE_MODE: "disabled",
};
assertExit(
  runValidator({ fixture: ordinaryStagingFixture }),
  true,
  "Clean operator-only staging identity bootstrap validation",
);
const stagingRequireUrl = syntheticStagingDatabaseUrl.replace(
  "sslmode=verify-full",
  "sslmode=require",
);
assertExit(
  runValidator({
    fixture: ordinaryStagingFixture,
    overrides: {
      DATABASE_URL: stagingRequireUrl,
      PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(stagingRequireUrl),
      PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256:
        sha256(stagingRequireUrl),
    },
  }),
  false,
  "Staging bootstrap validation with sslmode=require",
);
for (const [label, overrides] of [
  ["a legacy anon key", { SUPABASE_ANON_KEY: productionLegacyAnonKey }],
  ["a legacy service-role key", { SUPABASE_SERVICE_ROLE_KEY: productionLegacyServiceRoleKey }],
  ["a malformed publishable key", { SUPABASE_ANON_KEY: `sb_publishable_${"x".repeat(19)}` }],
  ["a malformed secret key", { SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"x".repeat(221)}` }],
  ["a production operational-copy URL", { OFFSITE_BACKUP_SUPABASE_URL: syntheticBackupSupabaseUrl }],
  ["a production operational-copy secret", { OFFSITE_BACKUP_SERVICE_ROLE_KEY: stagingServiceKey }],
  ["a production operational-copy bucket", { OFFSITE_BACKUP_BUCKET: "pintpath-backups" }],
]) {
  assertExit(
    runValidator({ fixture: ordinaryStagingFixture, overrides }),
    false,
    `Staging bootstrap validation with ${label}`,
  );
}
for (const variable of [
  "REDIS_URL",
  "PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID",
  "PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID",
  "PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID",
  "PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID",
  "PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256",
  "PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID",
  "PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256",
]) {
  assertExit(
    runValidator({ fixture: ordinaryStagingFixture, unset: [variable] }),
    false,
    `Staging bootstrap without protected self pin ${variable}`,
  );
}
assertExit(
  runValidator({
    fixture: ordinaryStagingFixture,
    overrides: { PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: productionDatabaseResource },
  }),
  false,
  "Staging bootstrap with invented sibling identities",
);
assertExit(
  runValidator({
    fixture: ordinaryStagingFixture,
    overrides: { PINTPATH_DATABASE_RESOURCE_ID: `railway:${syntheticStagingEnvironmentId}:fixture-postgres` },
  }),
  false,
  "Staging bootstrap with a placeholder resource identity",
);
assertExit(
  runValidator({
    fixture: ordinaryStagingFixture,
    overrides: { RAILWAY_ENVIRONMENT_NAME: "production" },
  }),
  false,
  "Production validation with staging-bootstrap phase",
);
for (const nodeEnv of ["", "development"]) {
  assertExit(
    runValidator({ fixture: ordinaryStagingFixture, overrides: { NODE_ENV: nodeEnv } }),
    false,
    `Ordinary hosted staging validation with NODE_ENV=${nodeEnv || "unset"}`,
  );
}
assertExit(
  runValidator({ fixture: ordinaryStagingFixture, unset: ["DATABASE_URL"] }),
  false,
  "Ordinary staging validation without Postgres",
);
assertExit(
  runValidator({ fixture: ordinaryStagingFixture, overrides: { DATABASE_PATH: "/app/data/pint-path.sqlite" } }),
  false,
  "Ordinary staging validation with SQLite",
);
assertExit(
  runValidator({ fixture: ordinaryStagingFixture, overrides: { PUBLIC_BASE_URL: "http://ordinary-staging.up.railway.app" } }),
  false,
  "Ordinary staging validation with insecure transport",
);
assertExit(
  runValidator({
    fixture: restoreRehearsalFixture,
    overrides: {
      RAILWAY_ENVIRONMENT_ID: "fixture-permanent-staging-environment",
    },
  }),
  false,
  "Restore validation with permanent-staging Railway reuse",
);
assertExit(
  runValidator({
    fixture: restoreRehearsalFixture,
    overrides: { SUPABASE_URL: syntheticPermanentStagingSupabaseUrl },
  }),
  false,
  "Restore validation with permanent-staging Supabase reuse",
);
assertExit(
  runValidator({
    fixture: restoreRehearsalFixture,
    overrides: { SUPABASE_URL: restoreRehearsalFixture.RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL },
  }),
  false,
  "Restore validation with production Supabase reuse",
);
assertExit(
  runValidator({ fixture: restoreRehearsalFixture, overrides: { RESEND_API_KEY: "ci-forbidden-resend-key" } }),
  false,
  "Restore validation with an external-write credential",
);
assertExit(
  runValidator({
    fixture: restoreRehearsalFixture,
    overrides: { RESEND_TRANSACTIONAL_API_KEY: "ci-forbidden-transactional-resend-key" },
  }),
  false,
  "Restore validation with an account-deletion notification credential",
);
assertExit(
  runValidator({ fixture: restoreRehearsalFixture, overrides: { PINTPATH_SMOKE_USER_PASSWORD: "ci-forbidden-smoke-secret" } }),
  false,
  "Restore validation with a production smoke credential",
);
assertExit(
  runValidator({ fixture: restoreRehearsalFixture, overrides: { FIELD_TEST_MODE: "true" } }),
  false,
  "Restore validation with field-test mode enabled",
);

console.log("Production and restore-rehearsal deployment guard contracts passed.");
