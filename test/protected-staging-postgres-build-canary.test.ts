import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PROTECTED_STAGING_POSTGRES_BUILD_CANARY_SCHEMA,
  runProtectedStagingPostgresBuildCanary,
} from "../scripts/execute-protected-staging-postgres-build-canary.js";
import {
  STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK,
} from "../scripts/lib/staging-postgres-build-canary-railway-contract.js";

const root = path.resolve(import.meta.dirname, "..");
const candidate = "a".repeat(40);
const oldDeployment = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "33333333-3333-4333-8333-333333333333";
const metadataToken = "railway-staging-metadata-token";
const writeToken = "railway-staging-canary-write-token";

function scope() {
  return { data: { projectToken: {
    projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
    environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  } } };
}

function target(latestId: string) {
  const environmentId = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
  const serviceId = "bb84fecc-a125-49ce-853f-d2f25f7019c5";
  return { data: {
    environment: {
      id: environmentId,
      variables: {
        edges: ["RAILPACK_PACKAGES", "STAGING_POSTGRES_CA_CANARY_MODE",
          "STAGING_POSTGRES_CA_CANARY_RAILWAY_CONFIG_PATH"].map((name, index) => ({ node: {
            id: `variable-${index}`, name, environmentId, serviceId,
            isSealed: false, references: [],
          } })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      volumeInstances: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
    },
    staged: { environmentId, patch: {} },
    serviceInstance: {
      id: "716b4818-7695-4b9f-b5f9-35249e785a58",
      serviceId,
      serviceName: "postgres-backup-canary-2d276b6",
      environmentId,
      numReplicas: 1,
      source: null,
      domains: { serviceDomains: [], customDomains: [] },
      cronSchedule: null,
      startCommand: "node dist/scripts/staging-postgres-backup-canary.js",
      latestDeployment: { id: latestId, status: "SUCCESS", deploymentStopped: true,
        snapshotId: latestId === deploymentId ? snapshotId : null },
      activeDeployments: [],
    },
    tcpProxies: [],
  } };
}

function buildOnlyReceipt() {
  const lock = STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK;
  return {
    schemaVersion: lock.canarySchema,
    scope: lock.canaryScope,
    mode: "build-only",
    outcome: "passed",
    deploymentId,
    transport: { profile: lock.transportProfile, rootCaDerSha256: lock.rootCaDerSha256 },
    candidates: { adminUrlSha256: null, databaseIdentitySha256: null },
    identity: {
      railwayProject: true, railwayEnvironment: true, railwayService: true,
      railwayServiceName: true, railwayDeployment: true, dedicatedRailwayConfig: true,
      forbiddenEnvironmentAbsent: true, node22_23_2: true,
      credentialEnvironmentCleared: true, credentialInputsExact: true,
      runtimeUidExact: true, adminUrlAuthority: false, rootCaAuthority: false,
      transportAuthority: false, tlsScram: false, readOnlyTransaction: false,
      stagingDatabase: false, administrator: false,
    },
  };
}

function provider(): typeof fetch {
  let targetCalls = 0;
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { operationName: string };
    let value: unknown;
    if (body.operationName.endsWith("Scope")) value = scope();
    else if (body.operationName.endsWith("Target")) {
      targetCalls += 1;
      value = targetCalls === 1 ? target(oldDeployment) : target(deploymentId);
    } else if (body.operationName.endsWith("Deployment")) value = { data: { deployment: {
      id: deploymentId,
      projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
      environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
      serviceId: "bb84fecc-a125-49ce-853f-d2f25f7019c5",
      status: "SUCCESS", deploymentStopped: true, snapshotId,
      meta: { imageDigest: `sha256:${"d".repeat(64)}`, commitHash: candidate },
    } } };
    else value = { data: { deploymentLogs: [{
      timestamp: "2026-08-13T00:00:00Z",
      message: JSON.stringify(buildOnlyReceipt()),
      attributes: [],
    }] } };
    return new Response(JSON.stringify(value), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("protected staging Postgres build canary", () => {
  it("performs one exact upload and accepts only the stopped canonical build-only receipt", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-build-canary-test-"));
    const source = path.join(temporary, "source");
    const evidence = path.join(temporary, "evidence");
    fs.mkdirSync(source, { mode: 0o700 });
    fs.mkdirSync(evidence, { mode: 0o700 });
    fs.copyFileSync(path.join(root, "railway.postgres-backup-canary.toml"),
      path.join(source, "railway.postgres-backup-canary.toml"));
    const output: string[] = [];
    const boundary = vi.fn(async () => true);
    const runCommand = vi.fn(async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `${JSON.stringify({
        deploymentId,
        logsUrl: `https://railway.com/project/48d8c6cd-1c66-4148-874b-20877f48e1a5/service/bb84fecc-a125-49ce-853f-d2f25f7019c5?environmentId=a4e0f507-d6d3-4df9-a818-ad92c0071a35&id=${deploymentId}`,
      })}\n`,
    }));
    try {
      const exit = await runProtectedStagingPostgresBuildCanary({
        argv: ["--candidate-sha", candidate, "--evidence-dir", evidence],
        env: {
          GITHUB_REF: "refs/heads/main", GITHUB_SHA: candidate,
          GITHUB_RUN_ATTEMPT: "1",
          PINTPATH_POSTGRES_BUILD_CANARY_CONFIRMATION:
            "RUN_PERMANENT_STAGING_POSTGRES_BUILD_CANARY",
          PINTPATH_RAILWAY_CLI_PATH: "/reviewed/railway",
          PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: metadataToken,
          PINTPATH_RAILWAY_STAGING_POSTGRES_CANARY_DEPLOY_TOKEN: writeToken,
        },
        cwd: root, fetchImpl: provider(), now: () => 1_000,
        sleep: async () => undefined, runCommand, validateCli: () => true,
        createSnapshot: () => ({
          directory: source, archiveSha256: "b".repeat(64), treeSha: "c".repeat(40),
          cleanup: () => { fs.rmSync(source, { recursive: true }); return true; },
        }),
        runBoundary: boundary, writeOutput: (value) => output.push(value),
      });
      expect(exit).toBe(0);
      expect(runCommand).toHaveBeenCalledTimes(1);
      expect(vi.mocked(runCommand).mock.calls[0]?.[1]).toEqual([
        "up", source, "--path-as-root", "--no-gitignore", "--detach", "--json",
        "--project", "48d8c6cd-1c66-4148-874b-20877f48e1a5",
        "--environment", "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
        "--service", "bb84fecc-a125-49ce-853f-d2f25f7019c5",
        "--message", expect.stringMatching(/^pintpath:postgres-build-canary:/),
      ]);
      expect(boundary).toHaveBeenCalledTimes(2);
      const receipt = JSON.parse(output[0]!) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        schemaVersion: PROTECTED_STAGING_POSTGRES_BUILD_CANARY_SCHEMA,
        outcome: "passed", attempts: 1, retryAllowed: false,
        deploymentId,
        checks: {
          acknowledgementExact: true, postflightAttempted: true,
          deploymentExact: true, buildReceiptExact: true,
          collateralUnchanged: true, boundaryPostflightExact: true,
          cleanupExact: true, terminalEvidenceExact: true,
        },
      });
      expect(fs.readdirSync(evidence).sort()).toEqual(["intent.json", "terminal.json"]);
      expect(output[0]).not.toContain(metadataToken);
      expect(output[0]).not.toContain(writeToken);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("keeps the successor workflow protected, one-shot, pinned, and reasserted", () => {
    const workflow = fs.readFileSync(path.join(root,
      ".github/workflows/permanent-staging-postgres-build-canary.yml"), "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("environment: permanent-staging-postgres-build-canary");
    expect(workflow).toContain("test \"$RUN_ATTEMPT\" = 1");
    expect(workflow).toContain("git fetch --no-tags origin");
    expect(workflow).toContain("railway-v5.32.0-x86_64-unknown-linux-musl.tar.gz");
    expect(workflow).not.toContain("npm install --global");
    expect(workflow).not.toMatch(/continue-on-error|retry/i);
  });
});
