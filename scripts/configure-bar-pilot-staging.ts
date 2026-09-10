import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runProtectedRuntimeVariableUpsert } from "./execute-protected-runtime-variable-upsert.js";
import { barPilotVariableValueExact } from "./lib/bar-pilot-staging-contract.js";
import { writePrivateExclusiveFile } from "./lib/trusted-filesystem.js";
import {
  assertPostgresRailwayStockLocalhostRootCaPem,
  parsePostgresRailwayStockLocalhostCaUrl,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import {
  parsePermanentStagingAppDeploymentPolicy,
  permanentStagingAppDeploymentExecutorInternals,
} from "./lib/permanent-staging-app-deployment-executor.js";

type Environment = Readonly<Record<string, string | undefined>>;

// All inputs are validated before the first skipDeploys mutation. With no
// legitimate demo customer supplied, the demo endpoint stays disabled.
export function barPilotStagingConfigurationPlan(env: Environment): ReadonlyArray<readonly [string, string]> {
  const candidate = env.GITHUB_SHA ?? "";
  const enabled = env.PINTPATH_BAR_PILOT_ENABLED ?? "";
  const venueIds = env.PINTPATH_BAR_PILOT_VENUE_IDS ?? "";
  const customerIds = env.PINTPATH_BAR_PILOT_DEMO_CUSTOMER_IDS ?? "";
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REF !== "refs/heads/main"
    || env.GITHUB_RUN_ATTEMPT !== "1" || !/^[a-f0-9]{40}$/.test(candidate)
    || env.PINTPATH_BAR_PILOT_CANDIDATE_SHA !== candidate
    || !barPilotVariableValueExact("BAR_PILOT_ENABLED", enabled, candidate)
    || (enabled === "true" && customerIds === "")
    || !barPilotVariableValueExact("BAR_PILOT_VENUE_IDS", venueIds, candidate)
    || (customerIds !== "" && !barPilotVariableValueExact("BAR_PILOT_DEMO_CUSTOMER_IDS", customerIds, candidate))) {
    throw new Error("Pilot staging authority or allowlist is invalid.");
  }
  const maintenanceUrl = env.PINTPATH_STAGING_DATABASE_MAINTENANCE_URL ?? "";
  const caPem = env.PINTPATH_STAGING_PINTPATH_POSTGRES_ROOT_CA_PEM ?? "";
  const caDigest = env.PINTPATH_STAGING_PINTPATH_POSTGRES_ROOT_CA_DER_SHA256 ?? "";
  try {
    const parsed = parsePostgresRailwayStockLocalhostCaUrl(maintenanceUrl);
    assertPostgresRailwayStockLocalhostRootCaPem(caPem, caDigest);
    const url = new URL(parsed.connectionString);
    const canonicalPem = caPem.endsWith("\n") ? caPem.slice(0, -1) : caPem;
    if (maintenanceUrl !== maintenanceUrl.trim() || /[\u0000-\u0020\u007f]/.test(maintenanceUrl)
      || !/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----$/.test(canonicalPem)
      || url.protocol !== "postgresql:" || !url.username || !url.password
      || url.hostname !== "postgres-staging.railway.internal"
      || url.pathname !== "/pintpath_staging"
      || url.search !== "?sslmode=verify-full" || url.hash) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("Protected staging maintenance URL or matching CA is unavailable or invalid.");
  }
  return [
    ["PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED", "false"],
    ["PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA", candidate],
    ["DATABASE_MAINTENANCE_URL", maintenanceUrl],
    ["PINTPATH_POSTGRES_ROOT_CA_PEM", caPem],
    ["PINTPATH_POSTGRES_ROOT_CA_DER_SHA256", caDigest],
    ["BAR_PILOT_DEMO_ENABLED", "false"],
    ["BAR_PILOT_VENUE_IDS", venueIds],
    ...(customerIds ? [["BAR_PILOT_DEMO_CUSTOMER_IDS", customerIds] as const] : []),
    ["BAR_PILOT_ENABLED", enabled],
    ...(enabled === "true" && customerIds
      ? [["BAR_PILOT_DEMO_ENABLED", "true"] as const] : []),
  ];
}

interface Dependencies {
  env: Environment;
  evidenceDirectory: string;
  assertCurrentMain: () => void;
  assertCurrentRuntime: (env: Environment) => Promise<void>;
  upsert: typeof runProtectedRuntimeVariableUpsert;
  output: (value: string) => void;
}

async function assertCurrentRuntime(env: Environment): Promise<void> {
  const id = env.PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID ?? "";
  if (!id) return;
  const policy = parsePermanentStagingAppDeploymentPolicy(fs.readFileSync(
    "ops/railway/bar-pilot-staging-app-deployment-policy.json", "utf8"));
  if (!policy) throw new Error("Pilot policy is invalid.");
  await permanentStagingAppDeploymentExecutorInternals.defaultProbeRuntime(
    fetch, policy.target.publicOrigin, env.GITHUB_SHA!, policy, policy.target.environmentId, id);
}

function assertCurrentMain(): void {
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0) throw new Error("Current main verification failed.");
    return result.stdout.trim();
  };
  git(["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  if (git(["rev-parse", "HEAD"]) !== process.env.GITHUB_SHA
    || git(["rev-parse", "refs/remotes/origin/main"]) !== process.env.GITHUB_SHA
    || git(["status", "--porcelain=v2", "--untracked-files=all"]) !== "") {
    throw new Error("Current main verification failed.");
  }
}

export async function runBarPilotStagingConfiguration(overrides: Partial<Dependencies> = {}): Promise<0 | 1> {
  const deps: Dependencies = {
    env: process.env,
    evidenceDirectory: process.env.PINTPATH_BAR_PILOT_CONFIGURATION_EVIDENCE ?? "",
    assertCurrentMain,
    assertCurrentRuntime,
    upsert: runProtectedRuntimeVariableUpsert,
    output: (value) => process.stdout.write(value),
    ...overrides,
  };
  const completed: string[] = [];
  let inputs: string | null = null;
  let ok = false;
  try {
    const plan = barPilotStagingConfigurationPlan(deps.env);
    await deps.assertCurrentRuntime(deps.env);
    if (!path.isAbsolute(deps.evidenceDirectory)) throw new Error("Evidence path is invalid.");
    fs.mkdirSync(deps.evidenceDirectory, { mode: 0o700 });
    inputs = fs.mkdtempSync(path.join(path.dirname(deps.evidenceDirectory), "pilot-private-inputs-"));
    fs.chmodSync(inputs, 0o700);
    for (const [index, [name, value]] of plan.entries()) {
      deps.assertCurrentMain();
      const leaf = `${index}-${name}`;
      writePrivateExclusiveFile(inputs, leaf, value, { requireOwner: true });
      const evidence = path.join(deps.evidenceDirectory, leaf);
      fs.mkdirSync(evidence, { mode: 0o700 });
      const result = await deps.upsert({
        argv: ["--target", "permanent-staging", "--variable", name,
          "--value-file", path.join(inputs, leaf), "--evidence-dir", evidence,
          "--candidate-sha", deps.env.GITHUB_SHA!],
        env: {
          ...deps.env,
          PINTPATH_BAR_PILOT_STAGING_CONFIGURATION: "true",
          PINTPATH_RUNTIME_VARIABLE_CONFIRMATION: `UPSERT_${name}_IN_PERMANENT_STAGING`,
        },
      });
      if (result !== 0) throw new Error("Configuration stopped; inspect the secret-free operation receipt.");
      completed.push(name);
    }
    ok = true;
  } catch {
    // Provider responses and protected values must never enter logs or artifacts.
  } finally {
    if (inputs) fs.rmSync(inputs, { recursive: true, force: true });
  }
  const receipt = `${JSON.stringify({ schemaVersion: "pintpath-bar-pilot-staging-configuration/v1",
    candidateSha: deps.env.GITHUB_SHA, ok, completedVariables: completed,
    automaticMaintenanceEnabled: false, skipDeploys: true, retryAllowed: false,
    ownerGoogleSignInStillRequired: true })}\n`;
  try {
    writePrivateExclusiveFile(deps.evidenceDirectory, "configuration.json", receipt, { requireOwner: true });
  } catch {
    deps.output("Pilot staging configuration failed before a durable receipt was available. No automatic retry is allowed.\n");
    return 1;
  }
  deps.output(receipt);
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBarPilotStagingConfiguration();
}
