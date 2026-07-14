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
  PUBLIC_BASE_URL: "https://pintpath.au",
  PORT: "3000",
  GOOGLE_MAPS_API_KEY: "ci-maps-browser-key",
  GOOGLE_MAPS_MAP_ID: "ci-vector-map-id",
  GOOGLE_PLACES_API_KEY: "ci-places-server-key",
  OPENAI_API_KEY: "ci-menu-extraction-key", // security-scan allow: synthetic deploy-guard fixture
  SUPABASE_URL: "https://production-ci.supabase.co",
  SUPABASE_ANON_KEY: "ci-browser-safe-key",
  SUPABASE_SERVICE_ROLE_KEY: "ci-primary-server-key",
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
};

function runValidator({ overrides = {}, unset = [] } = {}) {
  const env = { ...process.env, ...productionFixture, ...overrides };
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

console.log("Production deployment guard contract passed.");
