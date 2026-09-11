import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { barPilotStagingConfigurationPlan, runBarPilotStagingConfiguration } from "../scripts/configure-bar-pilot-staging.js";
import { BAR_PILOT_STAGING_VARIABLES, BAR_PILOT_STOPPED_DEPLOYMENT_ID, barPilotCurrentDeploymentExact, barPilotStoppedDeploymentExact, barPilotVariableValueExact } from "../scripts/lib/bar-pilot-staging-contract.js";
import { protectedRuntimeVariableInternals } from "../scripts/execute-protected-runtime-variable-upsert.js";
import { TEST_POSTGRES_RAILWAY_ROOT_CA_PEM } from "./postgres-railway-stock-localhost-ca.fixtures.js";
import * as healthyRollout from "../scripts/lib/bar-pilot-healthy-rollout.js";
import { railwayDeploymentIdentityIdSha256 } from "../src/lib/railway-deployment-identity.js";
import { canonicalProtectedSourceArchiveManifest } from "../src/lib/protected-source-archive.js";

const candidate = "a".repeat(40);
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function environment() {
  return {
    GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: candidate,
    PINTPATH_BAR_PILOT_CANDIDATE_SHA: candidate, PINTPATH_BAR_PILOT_ENABLED: "false",
    PINTPATH_BAR_PILOT_VENUE_IDS: "pintpath-pilot-demo:venue:v1", PINTPATH_BAR_PILOT_DEMO_CUSTOMER_IDS: "",
    PINTPATH_STAGING_DATABASE_MAINTENANCE_URL: "postgresql://staging_maintenance:private-test-value@postgres-staging.railway.internal:5432/pintpath_staging?sslmode=verify-full",
    PINTPATH_STAGING_PINTPATH_POSTGRES_ROOT_CA_PEM: TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
    PINTPATH_STAGING_PINTPATH_POSTGRES_ROOT_CA_DER_SHA256: crypto.createHash("sha256")
      .update(new crypto.X509Certificate(TEST_POSTGRES_RAILWAY_ROOT_CA_PEM).raw).digest("hex"),
  };
}
function directory() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pilot-configuration-")));
  roots.push(root); return path.join(root, "evidence");
}

describe("bar pilot staging configuration", () => {
  it("keeps public readiness pilot and demo disabled without inventing a customer", () => {
    const plan = new Map(barPilotStagingConfigurationPlan(environment()));
    expect(plan.get("BAR_PILOT_ENABLED")).toBe("false");
    expect(plan.get("BAR_PILOT_DEMO_ENABLED")).toBe("false");
    expect(plan.has("BAR_PILOT_DEMO_CUSTOMER_IDS")).toBe(false);
    expect(plan.get("PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED")).toBe("false");
    expect(plan.get("PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA")).toBe(candidate);
    expect(plan.has("SUPABASE_SERVICE_ROLE_KEY")).toBe(false);
  });
  it("enables only explicit venue and legitimate customer identifiers", () => {
    const env = environment(); env.PINTPATH_BAR_PILOT_ENABLED = "true";
    env.PINTPATH_BAR_PILOT_DEMO_CUSTOMER_IDS = "d020f930-1234-4567-8123-123456789abc";
    const plan = barPilotStagingConfigurationPlan(env);
    expect(new Map(plan).get("BAR_PILOT_DEMO_ENABLED")).toBe("true");
    expect(plan.findIndex(([name]) => name === "BAR_PILOT_DEMO_CUSTOMER_IDS"))
      .toBeLessThan(plan.findLastIndex(([name]) => name === "BAR_PILOT_DEMO_ENABLED"));
  });
  it.each([
    { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_REF: "refs/heads/pilot" }, { PINTPATH_BAR_PILOT_CANDIDATE_SHA: "b".repeat(40) },
    { PINTPATH_BAR_PILOT_RECOVER_FAILED_STARTUP: "yes" },
    { PINTPATH_BAR_PILOT_RECOVER_FAILED_STARTUP: "true", PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID: "11111111-1111-4111-8111-111111111111" },
    { PINTPATH_BAR_PILOT_PREVIOUS_CANDIDATE_SHA: "b".repeat(40) },
    { PINTPATH_BAR_PILOT_PREVIOUS_CANDIDATE_SHA: "HEAD~1", PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID: "11111111-1111-4111-8111-111111111111" },
    { PINTPATH_BAR_PILOT_VENUE_IDS: "*" }, { PINTPATH_BAR_PILOT_VENUE_IDS: "venue,venue" },
    { PINTPATH_BAR_PILOT_DEMO_CUSTOMER_IDS: "customer\nsecret" },
    { PINTPATH_BAR_PILOT_ENABLED: "true", PINTPATH_BAR_PILOT_DEMO_CUSTOMER_IDS: "" },
    { PINTPATH_STAGING_DATABASE_MAINTENANCE_URL: "postgresql://user:password@postgres-staging.railway.internal/pintpath_staging?sslmode=verify-full" },
    { PINTPATH_STAGING_DATABASE_MAINTENANCE_URL: "postgresql://user:password@postgres-staging.railway.internal:5433/pintpath_staging?sslmode=verify-full" },
    { PINTPATH_STAGING_DATABASE_MAINTENANCE_URL: "postgresql://user:password@other.railway.internal:5432/pintpath_staging?sslmode=verify-full" },
    { PINTPATH_STAGING_PINTPATH_POSTGRES_ROOT_CA_PEM: TEST_POSTGRES_RAILWAY_ROOT_CA_PEM + TEST_POSTGRES_RAILWAY_ROOT_CA_PEM },
    { PINTPATH_STAGING_DATABASE_MAINTENANCE_URL: "postgresql://user:password@production.railway.internal/production?sslmode=verify-full" },
    { PINTPATH_STAGING_PINTPATH_POSTGRES_ROOT_CA_DER_SHA256: "b".repeat(64) },
  ])("rejects unsafe configuration before any provider call: %j", async (edit) => {
    const upsert = vi.fn(); const runtime = vi.fn();
    expect(await runBarPilotStagingConfiguration({ env: { ...environment(), ...edit },
      evidenceDirectory: directory(), assertCurrentMain: vi.fn(), assertCurrentRuntime: runtime,
      upsert, output: vi.fn() })).toBe(1);
    expect(upsert).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled();
  });
  it("uses private input files, exact single-variable primitives, and secret-free receipts", async () => {
    const env = environment(); const evidence = directory(); const outputs: string[] = [];
    const currentMain = vi.fn();
    const upsert = vi.fn(async (options) => {
      expect(options.env.PINTPATH_BAR_PILOT_STAGING_CONFIGURATION).toBe("true");
      const args = options.argv as string[];
      const filename = args[args.indexOf("--value-file") + 1]!;
      expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(filename, "utf8").length).toBeGreaterThan(0);
      expect(args.slice(0, 2)).toEqual(["--target", "permanent-staging"]);
      return 0 as const;
    });
    expect(await runBarPilotStagingConfiguration({ env, evidenceDirectory: evidence,
      assertCurrentMain: currentMain, assertCurrentRuntime: vi.fn(), upsert, output: (v) => outputs.push(v) })).toBe(0);
    expect(currentMain).toHaveBeenCalledTimes(8);
    expect(upsert).toHaveBeenCalledTimes(8);
    expect(fs.readdirSync(path.dirname(evidence))).toEqual(["evidence"]);
    const receipt = fs.readFileSync(path.join(evidence, "configuration.json"), "utf8");
    expect(receipt + outputs.join("")).not.toContain("private-test-value");
    expect(receipt).not.toContain("BEGIN CERTIFICATE");
    expect(JSON.parse(receipt)).toMatchObject({ ok: true, skipDeploys: true, retryAllowed: false });
  });
  it("halts after the first failed operation and deletes all input custody", async () => {
    const upsert = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const evidence = directory();
    expect(await runBarPilotStagingConfiguration({ env: environment(), evidenceDirectory: evidence,
      assertCurrentMain: vi.fn(), assertCurrentRuntime: vi.fn(), upsert, output: vi.fn() })).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(path.dirname(evidence))).toEqual(["evidence"]);
    expect(JSON.parse(fs.readFileSync(path.join(evidence, "configuration.json"), "utf8")))
      .toMatchObject({ ok: false, completedVariables: ["PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED"] });
  });
  it("requires current runtime proof before configuring a live candidate", async () => {
    const upsert = vi.fn();
    expect(await runBarPilotStagingConfiguration({ env: environment(), evidenceDirectory: directory(),
      assertCurrentMain: vi.fn(), assertCurrentRuntime: vi.fn().mockRejectedValue(new Error("wrong runtime")),
      upsert, output: vi.fn() })).toBe(1);
    expect(upsert).not.toHaveBeenCalled();
  });
  it("proves the declared previous runtime and ancestry before configuring the reviewed successor", async () => {
    const previous = "b".repeat(40);
    const id = "11111111-1111-4111-8111-111111111111";
    const env = { ...environment(), PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID: id,
      PINTPATH_BAR_PILOT_PREVIOUS_CANDIDATE_SHA: previous };
    const ancestry = vi.spyOn(healthyRollout, "assertBarPilotPreviousCandidateAncestor").mockReturnValue();
    const manifest = { schemaVersion: "protected-source-archive/v1" as const,
      candidateSha: previous, treeSha: "c".repeat(40), sourceArchiveSha256: "d".repeat(64),
      sourceBaseManifestSha256: "e".repeat(64), uploadNonce: "f".repeat(64) };
    const runtime = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const route = new URL(String(input)).pathname;
      return Response.json({ ok: true, data: { service: "pint-path",
        status: route === "/health" ? "ok" : route === "/startup" ? "startup_ready" : "ready",
        deployment: { version: "0.1.0", commitSha: "unknown", environment: "production",
          projectIdSha256: railwayDeploymentIdentityIdSha256("project", "48d8c6cd-1c66-4148-874b-20877f48e1a5"),
          environmentIdSha256: railwayDeploymentIdentityIdSha256("environment", "a4e0f507-d6d3-4df9-a818-ad92c0071a35"),
          serviceIdSha256: railwayDeploymentIdentityIdSha256("service", "6816c4a2-e392-4ee5-826f-2584cb599ec0"),
          deploymentIdSha256: railwayDeploymentIdentityIdSha256("deployment", id),
          replicaIdSha256: "c".repeat(64),
          sourceArchive: { ...manifest, sourceIdentitySha256: crypto.createHash("sha256")
            .update(canonicalProtectedSourceArchiveManifest(manifest)).digest("hex") },
        }, automaticMaintenance: { enabled: false, candidateBound: true },
        ...(route === "/health" ? {} : { dependencies: {} }),
      } });
    });
    const upsert = vi.fn().mockResolvedValue(0);
    const currentMain = vi.fn();
    expect(await runBarPilotStagingConfiguration({ env, evidenceDirectory: directory(),
      assertCurrentMain: currentMain, upsert, output: vi.fn() })).toBe(0);
    expect(runtime.mock.calls.map(([url]) => String(url))).toEqual([
      "https://beer-staging.up.railway.app/health", "https://beer-staging.up.railway.app/startup",
      "https://beer-staging.up.railway.app/ready",
    ]);
    expect(currentMain).toHaveBeenCalledTimes(9);
    expect(ancestry).toHaveBeenCalledTimes(9);
    expect(ancestry).toHaveBeenCalledWith(process.cwd(), previous, candidate);
    expect(upsert).toHaveBeenCalledTimes(8);
    expect(ancestry.mock.invocationCallOrder[0]).toBeLessThan(runtime.mock.invocationCallOrder[0]!);
    expect(runtime.mock.invocationCallOrder[0]).toBeLessThan(upsert.mock.invocationCallOrder[0]!);
  });
  it("rejects foreign ancestry before reading runtime or changing any configuration", async () => {
    vi.spyOn(healthyRollout, "assertBarPilotPreviousCandidateAncestor")
      .mockImplementation(() => { throw new Error("source_authority_failed"); });
    const upsert = vi.fn(); const runtime = vi.fn();
    expect(await runBarPilotStagingConfiguration({ env: { ...environment(),
      PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID: "11111111-1111-4111-8111-111111111111",
      PINTPATH_BAR_PILOT_PREVIOUS_CANDIDATE_SHA: "b".repeat(40) }, evidenceDirectory: directory(),
      assertCurrentMain: vi.fn(), assertCurrentRuntime: runtime, upsert, output: vi.fn() })).toBe(1);
    expect(runtime).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
  it("preserves staging isolation while permitting only the three reviewed real-pilot production settings", () => {
    const realPilotProductionVariables = new Set([
      "BAR_PILOT_ENABLED", "BAR_PILOT_VENUE_IDS", "ALCOHOL_PROMOTION_APPROVAL_REFERENCE",
    ]);
    for (const variable of BAR_PILOT_STAGING_VARIABLES) {
      expect(protectedRuntimeVariableInternals.targetVariableExact("permanent-staging", variable)).toBe(true);
      expect(protectedRuntimeVariableInternals.targetVariableExact("production", variable))
        .toBe(realPilotProductionVariables.has(variable));
      expect(protectedRuntimeVariableInternals.targetVariableExact("permanent-staging-postgres", variable)).toBe(false);
    }
    expect(protectedRuntimeVariableInternals.targetVariableExact("production", "ALCOHOL_PROMOTION_APPROVAL_REFERENCE")).toBe(true);
    expect(protectedRuntimeVariableInternals.targetVariableExact("permanent-staging", "ALCOHOL_PROMOTION_APPROVAL_REFERENCE")).toBe(false);
    for (const variable of ["BAR_PILOT_DEMO_ENABLED", "BAR_PILOT_DEMO_CUSTOMER_IDS",
      "PINT_POINTS_REWARDS_ENABLED", "ALCOHOL_GAMIFICATION_ENABLED", "COMMERCIAL_LAUNCH_ENABLED",
      "CONSUMER_PAID_ENROLLMENT_ENABLED"]) {
      expect(protectedRuntimeVariableInternals.targetVariableExact("production", variable)).toBe(false);
    }
    expect(barPilotVariableValueExact("PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED", "true", candidate)).toBe(false);
    expect(barPilotVariableValueExact("PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA", "b".repeat(40), candidate)).toBe(false);
  });
  it("distinguishes exact stopped predecessor from a healthy current candidate", () => {
    const stopped = { latestDeployment: { id: BAR_PILOT_STOPPED_DEPLOYMENT_ID, status: "SUCCESS", deploymentStopped: true }, activeDeployments: [] };
    expect(barPilotStoppedDeploymentExact(stopped)).toBe(true);
    expect(barPilotStoppedDeploymentExact({ ...stopped, latestDeployment: { ...stopped.latestDeployment, deploymentStopped: false } })).toBe(false);
    const id = "11111111-1111-4111-8111-111111111111";
    const row = { id, status: "SUCCESS", deploymentStopped: false };
    expect(barPilotCurrentDeploymentExact({ latestDeployment: row, activeDeployments: [row] }, id)).toBe(true);
    expect(barPilotCurrentDeploymentExact(stopped, BAR_PILOT_STOPPED_DEPLOYMENT_ID)).toBe(false);
    expect(barPilotCurrentDeploymentExact({ latestDeployment: row, activeDeployments: [row, row] }, id)).toBe(false);
  });
  it("keeps credential separation, shared concurrency, and a dependency between configuration and upload", () => {
    const workflow = fs.readFileSync(".github/workflows/deploy-bar-pilot-staging.yml", "utf8");
    const [configure, deploy] = workflow.split("  deploy:\n");
    expect(workflow).toContain("group: pintpath-permanent-staging-key-rollout");
    expect(configure).toContain("environment: permanent-staging-provider-mutation");
    expect(configure).toContain("PINTPATH_RAILWAY_STAGING_VARIABLE_MUTATION_TOKEN");
    expect(configure).not.toContain("PINTPATH_RAILWAY_STAGING_DEPLOY_TOKEN");
    expect(deploy).toContain("needs: configure");
    expect(deploy).toContain("environment: permanent-staging-deployment");
    expect(deploy).toContain("PINTPATH_RAILWAY_STAGING_DEPLOY_TOKEN");
    expect(deploy).not.toContain("PINTPATH_RAILWAY_STAGING_VARIABLE_MUTATION_TOKEN");
    expect(deploy).toContain("bar-pilot-staging-app-deployment-policy.json");
    expect(deploy).toContain("scripts/execute-bar-pilot-staging-app-deployment.ts");
    expect(deploy).not.toContain("scripts/execute-permanent-staging-app-deployment.ts");
    expect(workflow).not.toMatch(/railway (restart|redeploy|scale)/);
    expect(workflow).toContain("github:release-candidate:verify");
    expect(configure).toContain("PINTPATH_BAR_PILOT_RECOVER_FAILED_STARTUP: ${{ inputs.recover_failed_startup && 'true' || 'false' }}");
    expect(deploy).toContain("PINTPATH_BAR_PILOT_RECOVER_FAILED_STARTUP: ${{ inputs.recover_failed_startup && 'true' || 'false' }}");
    expect(configure).toContain("PINTPATH_BAR_PILOT_PREVIOUS_CANDIDATE_SHA: ${{ inputs.expected_previous_candidate_sha }}");
    expect(deploy).toContain("PINTPATH_BAR_PILOT_PREVIOUS_CANDIDATE_SHA: ${{ inputs.expected_previous_candidate_sha }}");
  });
});
