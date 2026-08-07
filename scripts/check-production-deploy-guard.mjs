import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(root, "package.json");
const railwayPath = path.join(root, "railway.toml");
const compiledEnvPath = path.join(root, "dist/src/config/env.js");
const expectedPredeployScript = "NODE_ENV=production node dist/src/config/env.js";

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

const productionFixture = {
  NODE_ENV: "production",
  RAILWAY_ENVIRONMENT_NAME: "production",
  PUBLIC_BASE_URL: "https://pintpath.au",
  PORT: "3000",
  GOOGLE_MAPS_API_KEY: "ci-maps-browser-key",
  GOOGLE_MAPS_MAP_ID: "ci-vector-map-id",
  GOOGLE_PLACES_API_KEY: "ci-places-server-key",
  OPENAI_API_KEY: "ci-menu-extraction-key", // security-scan allow: synthetic deploy-guard fixture
  SUPABASE_URL: "https://production-ci.supabase.co",
  SUPABASE_ANON_KEY: "ci-browser-safe-key",
  SUPABASE_SERVICE_ROLE_KEY: "ci-primary-server-key",
  SUPABASE_OAUTH_PROVIDERS: "google",
  OFFSITE_BACKUP_SUPABASE_URL: "https://backup-ci.supabase.co",
  OFFSITE_BACKUP_SERVICE_ROLE_KEY: "ci-independent-backup-server-key",
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
  RAILWAY_ENVIRONMENT_NAME: "staging",
  RAILWAY_ENVIRONMENT_ID: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  RAILWAY_PROJECT_ID: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  RAILWAY_SERVICE_ID: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
  RAILWAY_VOLUME_MOUNT_PATH: "/app/data",
  RAILWAY_PUBLIC_DOMAIN: "beer-staging.up.railway.app",
  RESTORE_REHEARSAL_MODE: "true",
  RESTORE_REHEARSAL_PHASE: "active",
  RESTORE_REHEARSAL_BACKUP_ID: "pint-path-ci-backup",
  RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL: "https://jxpubqlmqnnqwadmjgyk.supabase.co",
  RESTORE_REHEARSAL_BACKUP_SUPABASE_URL: "https://gjjffexmflwtnewtkkiy.supabase.co",
  RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  RESTORE_REHEARSAL_REDIS_SERVICE_ID: "d6351cec-fe04-4a6f-8e05-1cc164ea1e73",
  RESTORE_REHEARSAL_REDIS_SENTINEL: "ci-restore-redis-sentinel-42fbe92a-2f56",
  RESTORE_REHEARSAL_ACCESS_USERNAME: "restore-operator",
  RESTORE_REHEARSAL_ACCESS_PASSWORD: "ci-restore-access-1cd92e0a-784f-4f21",
  PUBLIC_BASE_URL: "https://beer-staging.up.railway.app",
  DATABASE_PATH: "/app/data/restore-pint-path-ci-backup/pint-path.sqlite",
  SOURCE_EVIDENCE_STORAGE_DIR: "/app/data/restore-pint-path-ci-backup/source-evidence",
  GOOGLE_MAPS_API_KEY: "ci-staging-origin-restricted-maps-key",
  GOOGLE_MAPS_MAP_ID: "ci-staging-vector-map-id",
  GOOGLE_PLACES_API_KEY: "",
  OPENAI_API_KEY: "",
  SUPABASE_URL: "https://ibveugyfyzjptyvautlr.supabase.co",
  SUPABASE_ANON_KEY: "ci-restore-browser-key",
  SUPABASE_SERVICE_ROLE_KEY: "ci-restore-service-key",
  SUPABASE_OAUTH_PROVIDERS: "",
  OFFSITE_BACKUP_SUPABASE_URL: "",
  OFFSITE_BACKUP_SERVICE_ROLE_KEY: "",
  SOURCE_EVIDENCE_SIGNING_SECRET: "ci-restore-source-bb07c1be-75cf-4ec8-b8f6",
  POS_WEBHOOK_SIGNING_SECRET: "",
  REDIS_URL: "redis://default:fixture-password@redis.railway.internal:6379",
  REDIS_KEY_NAMESPACE: "pint-path:restore:a4e0f507-d6d3-4df9-a818-ad92c0071a35:pint-path-ci-backup",
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
  runValidator({ fixture: restoreRehearsalFixture, overrides: { RESTORE_REHEARSAL_MODE: "false" } }),
  false,
  "Restore-shaped staging validation with restore rehearsal mode disabled",
);
const ordinaryStagingFixture = {
  NODE_ENV: "production",
  RAILWAY_ENVIRONMENT_NAME: "staging",
  RAILWAY_ENVIRONMENT_ID: "ordinary-staging-environment",
  PUBLIC_BASE_URL: "https://ordinary-staging.up.railway.app",
  SOURCE_EVIDENCE_SIGNING_SECRET: "ci-staging-source-bf644d2c-401c-493b-b590",
  POS_WEBHOOK_SIGNING_SECRET: "ci-staging-pos-f71ed34d-c2dd-4175-bda0",
  DEMO_BILLING_MODE: "false",
};
assertExit(
  runValidator({ fixture: ordinaryStagingFixture }),
  true,
  "Clean ordinary staging validation",
);
assertExit(
  runValidator({ fixture: ordinaryStagingFixture, overrides: { PUBLIC_BASE_URL: "http://ordinary-staging.up.railway.app" } }),
  false,
  "Ordinary staging validation with insecure transport",
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
