import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROTECTED_STAGING_SCALE_DISCOVERY_QUERY,
  PROTECTED_STAGING_SCALE_SCHEMA,
  PROTECTED_STAGING_SCALE_SNAPSHOT_QUERY,
  PROTECTED_STAGING_SCALE_STATE,
  PROTECTED_STAGING_SCALE_TOKEN_SCOPE_QUERY,
  runProtectedPermanentStagingScale,
} from "../scripts/execute-protected-permanent-staging-scale.js";
import type { ProductionScaleActivationPrerequisiteVerification } from
  "../scripts/verify-production-maintenance-role-limit-prerequisites.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";

const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const PRODUCTION_ENVIRONMENT_ID = "13dab015-df74-45c6-b26f-69323daea99a";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";
const DOMAIN_ID = "44444444-4444-4444-8444-444444444444";
const DRIFT_DEPLOYMENT_ID = "55555555-5555-4555-8555-555555555555";
const DRIFT_SNAPSHOT_ID = "66666666-6666-4666-8666-666666666666";
const CANDIDATE_SHA = "a".repeat(40);
const PRODUCTION_SCALE_RUN_ID = "9000";
const PRODUCTION_ACTIVATE_RUN_ID = "8000";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function scope(environmentId = ENVIRONMENT_ID): Response {
  return response({
    data: { projectToken: { projectId: PROJECT_ID, environmentId } },
  });
}

function discovery(deploymentId = DEPLOYMENT_ID): Response {
  return response({
    data: { serviceInstance: { latestDeployment: { id: deploymentId } } },
  });
}

function snapshot(
  replicas: 0 | 1 | 2,
  environmentId = ENVIRONMENT_ID,
  domain = "beer-staging.up.railway.app",
  deployedSha = CANDIDATE_SHA,
  deploymentId = DEPLOYMENT_ID,
  snapshotId = SNAPSHOT_ID,
  targetPort = 8080,
): Response {
  return response({
    data: {
      serviceInstance: {
        id: INSTANCE_ID,
        serviceId: SERVICE_ID,
        environmentId,
        numReplicas: replicas,
        latestDeployment: {
          id: deploymentId,
          status: "SUCCESS",
          deploymentStopped: false,
          snapshotId,
        },
        activeDeployments: [{
          id: deploymentId,
          status: "SUCCESS",
          deploymentStopped: false,
        }],
        domains: {
          serviceDomains: [{
            id: DOMAIN_ID,
            domain,
            targetPort,
          }],
          customDomains: [],
        },
      },
      deployment: {
        id: deploymentId,
        projectId: PROJECT_ID,
        environmentId,
        serviceId: SERVICE_ID,
        snapshotId,
        meta: {
          commitHash: deployedSha,
          imageDigest: `sha256:${"b".repeat(64)}`,
          patchId: null,
        },
      },
    },
  });
}

function environment(
  direction: "out" | "converge-one",
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CANDIDATE_SHA,
    GITHUB_RUN_ATTEMPT: "1",
    PINTPATH_SCALE_CONFIRMATION: direction === "out"
      ? "SCALE_PERMANENT_STAGING_TO_TWO_FOR_EVIDENCE"
      : "CONVERGE_PERMANENT_STAGING_TO_ONE",
    PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "metadata-token-that-is-long-enough",
    PINTPATH_RAILWAY_STAGING_SCALE_TOKEN: "scale-token-that-is-long-enough",
    PINTPATH_RAILWAY_CLI_PATH: "/private/railway",
    ...overrides,
  };
}

function argv(direction: "out" | "converge-one"): string[] {
  return [
    "--direction", direction,
    "--candidate-sha", CANDIDATE_SHA,
    "--evidence-dir", "/private/evidence",
  ];
}

function successfulFetch(before: 0 | 1 | 2, after?: 0 | 1 | 2) {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(scope())
    .mockResolvedValueOnce(scope())
    .mockResolvedValueOnce(discovery())
    .mockResolvedValueOnce(snapshot(before));
  if (after !== undefined) {
    fetchImpl
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(before))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(after));
  }
  return fetchImpl;
}

function durable(_directory: string, _leaf: string, source: string): string {
  return sha256(source);
}

describe("protected permanent-staging scale evidence operation", () => {
  it("pins metadata-only queries and a protected executor", () => {
    expect(PROTECTED_STAGING_SCALE_STATE).toBe("GITHUB_ENVIRONMENT_PROTECTED");
    expect(PROTECTED_STAGING_SCALE_DISCOVERY_QUERY).not.toMatch(/mutation\s/i);
    expect(PROTECTED_STAGING_SCALE_SNAPSHOT_QUERY).not.toMatch(/mutation\s/i);
    expect(PROTECTED_STAGING_SCALE_TOKEN_SCOPE_QUERY).not.toMatch(/mutation\s/i);
  });

  it("scales one reviewed candidate from one to two exactly once", async () => {
    const fetchImpl = successfulFetch(1, 2);
    const runCommand = vi.fn().mockResolvedValue({
      code: 0,
      timedOut: false,
      stdoutSha256: "c".repeat(64),
      stderrSha256: "d".repeat(64),
    });
    const boundaryCheck = vi.fn().mockResolvedValue(0);
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck,
      reassertRepositoryState: () => true,
      validateCli: () => true,
      runCommand,
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(0);
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith(
      "/private/railway",
      [
        "service", "scale", "asia-southeast1-eqsg3a=2",
        "--project", PROJECT_ID,
        "--environment", ENVIRONMENT_ID,
        "--service", SERVICE_ID,
        "--json",
      ],
      "scale-token-that-is-long-enough",
    );
    expect(boundaryCheck).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(JSON.parse(output[0]!)).toMatchObject({
      schemaVersion: PROTECTED_STAGING_SCALE_SCHEMA,
      direction: "out",
      outcome: "scaled",
      startedAt: "1970-01-01T00:00:00.000Z",
      completedAt: "1970-01-01T00:00:00.000Z",
      deploymentIdSha256:
        expect.stringMatching(/^[a-f0-9]{64}$/),
      desiredReplicas: 2,
      attempts: 1,
      retryAllowed: false,
      checks: {
        targetPreflightExact: true,
        runtimePreflightExact: true,
        acknowledgementExact: true,
        postflightAttempted: true,
        targetPostflightExact: true,
        runtimePostflightExact: true,
        candidateUnchanged: true,
        deploymentUnchanged: true,
        boundaryPostflightExact: true,
        terminalEvidenceExact: true,
        finalReceiptEvidenceExact: true,
      },
    });
  });

  it("quiesces the exact legacy staging deployment at zero without probing old runtime code", async () => {
    const legacySha = "b".repeat(40);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(1, ENVIRONMENT_ID, "beer-staging.up.railway.app", legacySha))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(1, ENVIRONMENT_ID, "beer-staging.up.railway.app", legacySha))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(0, ENVIRONMENT_ID, "beer-staging.up.railway.app", legacySha));
    const runCommand = vi.fn().mockResolvedValue({
      code: 0,
      timedOut: false,
      stdoutSha256: "c".repeat(64),
      stderrSha256: "d".repeat(64),
    });
    const probeRuntime = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: [
        "--direction", "quiesce-staging-zero",
        "--candidate-sha", CANDIDATE_SHA,
        "--expected-deployment-sha", legacySha,
        "--evidence-dir", "/private/evidence",
      ],
      env: {
        ...environment("out"),
        PINTPATH_SCALE_CONFIRMATION:
          "QUIESCE_PERMANENT_STAGING_TO_ZERO_FOR_WORKER_BOOTSTRAP",
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      validateCli: () => true,
      runCommand,
      probeRuntime,
      probeRuntimeAbsent: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(0);
    expect(probeRuntime).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledWith(
      "/private/railway",
      expect.arrayContaining(["asia-southeast1-eqsg3a=0"]),
      "scale-token-that-is-long-enough",
    );
    expect(JSON.parse(output[0]!)).toMatchObject({
      direction: "quiesce-staging-zero",
      outcome: "scaled",
      desiredReplicas: 0,
      checks: {
        runtimePreflightExact: true,
        runtimePostflightExact: true,
        deploymentUnchanged: true,
      },
    });
  });

  it("rejects a staging deployment whose service domain no longer targets the Railway app port", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(
        1,
        ENVIRONMENT_ID,
        "beer-staging.up.railway.app",
        CANDIDATE_SHA,
        DEPLOYMENT_ID,
        SNAPSHOT_ID,
        3000,
      ));
    const runCommand = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      validateCli: () => true,
      runCommand,
      probeRuntime: vi.fn(),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(1);
    expect(runCommand).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: { targetPreflightExact: false },
    });
  });

  it("restores the fenced candidate from zero to one and proves workers remain disabled", async () => {
    const fetchImpl = successfulFetch(0, 1);
    const runCommand = vi.fn().mockResolvedValue({
      code: 0,
      timedOut: false,
      stdoutSha256: "c".repeat(64),
      stderrSha256: "d".repeat(64),
    });
    const probeRuntime = vi.fn().mockResolvedValue(true);
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: [
        "--direction", "bootstrap-staging-one",
        "--candidate-sha", CANDIDATE_SHA,
        "--expected-deployment-sha", CANDIDATE_SHA,
        "--evidence-dir", "/private/evidence",
      ],
      env: {
        ...environment("out"),
        PINTPATH_SCALE_CONFIRMATION:
          "RESTORE_PERMANENT_STAGING_TO_ONE_FOR_WORKER_BOOTSTRAP",
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      validateCli: () => true,
      runCommand,
      probeRuntime,
      probeRuntimeAbsent: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(0);
    expect(probeRuntime).toHaveBeenCalledWith(
      expect.anything(),
      CANDIDATE_SHA,
      DEPLOYMENT_ID,
      { enabled: false, candidateBound: true },
    );
    expect(JSON.parse(output[0]!)).toMatchObject({
      direction: "bootstrap-staging-one",
      outcome: "scaled",
      desiredReplicas: 1,
      checks: {
        runtimePreflightExact: true,
        runtimePostflightExact: true,
      },
    });
  });

  it("treats a lost acknowledgement as uncertain without retrying", async () => {
    const fetchImpl = successfulFetch(1, 2);
    const runCommand = vi.fn().mockResolvedValue({
      code: null,
      timedOut: true,
      stdoutSha256: "c".repeat(64),
      stderrSha256: "d".repeat(64),
    });
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      validateCli: () => true,
      runCommand,
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(runCommand).toHaveBeenCalledOnce();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: 1,
      checks: {
        acknowledgementExact: false,
        postflightAttempted: true,
        targetPostflightExact: true,
      },
    });
  });

  it("blocks before scaling unless the exact candidate reports an active worker fence", async () => {
    const fetchImpl = successfulFetch(1);
    const runCommand = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      validateCli: () => true,
      runCommand,
      probeRuntime: vi.fn().mockResolvedValue(false),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(1);
    expect(runCommand).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: {
        targetPreflightExact: true,
        runtimePreflightExact: false,
      },
    });
  });

  it("makes converge-to-one idempotent and allows cleanup on a workflow rerun", async () => {
    const fetchImpl = successfulFetch(1);
    const runCommand = vi.fn();
    const boundaryCheck = vi.fn().mockResolvedValue(0);
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("converge-one"),
      env: environment("converge-one", { GITHUB_RUN_ATTEMPT: "2" }),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck,
      reassertRepositoryState: () => true,
      validateCli: () => true,
      runCommand,
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(0);
    expect(runCommand).not.toHaveBeenCalled();
    expect(boundaryCheck).toHaveBeenCalledTimes(2);
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "already_converged",
      attempts: 0,
      checks: { targetPostflightExact: true, terminalEvidenceExact: true },
    });
  });

  it("converges an exact existing production deployment to two without a scale-down path", async () => {
    const deployedSha = CANDIDATE_SHA;
    const evidenceDirectory = fs.realpathSync(fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-production-scale-test-"),
    ));
    temporaryRoots.push(evidenceDirectory);
    const activationVerificationFile = path.join(
      evidenceDirectory,
      "production-scale-activation-verification.json",
    );
    fs.writeFileSync(activationVerificationFile, "{}\n", { mode: 0o600 });
    const activationDeploymentIdSha256 = railwayDeploymentIdentityIdSha256(
      "deployment",
      DEPLOYMENT_ID,
    )!;
    const preActivationDeploymentIdSha256 = railwayDeploymentIdentityIdSha256(
      "deployment",
      "55555555-5555-4555-8555-555555555555",
    )!;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope(PRODUCTION_ENVIRONMENT_ID))
      .mockResolvedValueOnce(scope(PRODUCTION_ENVIRONMENT_ID))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(1, PRODUCTION_ENVIRONMENT_ID, "pintpath.au", deployedSha))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(1, PRODUCTION_ENVIRONMENT_ID, "pintpath.au", deployedSha))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(2, PRODUCTION_ENVIRONMENT_ID, "pintpath.au", deployedSha));
    const runCommand = vi.fn().mockResolvedValue({
      code: 0,
      timedOut: false,
      stdoutSha256: "c".repeat(64),
      stderrSha256: "d".repeat(64),
    });
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: [
        "--direction", "converge-production-two",
        "--candidate-sha", CANDIDATE_SHA,
        "--expected-deployment-sha", deployedSha,
        "--evidence-dir", evidenceDirectory,
        "--production-activation-run-id", PRODUCTION_ACTIVATE_RUN_ID,
        "--production-scale-verification-file", activationVerificationFile,
      ],
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_RUN_ID: PRODUCTION_SCALE_RUN_ID,
        GITHUB_SHA: CANDIDATE_SHA,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_SCALE_CONFIRMATION: "CONVERGE_PRODUCTION_TO_TWO_REPLICAS",
        PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN: "production-metadata-token-long-enough",
        PINTPATH_RAILWAY_PRODUCTION_SCALE_TOKEN: "production-scale-token-long-enough",
        PINTPATH_RAILWAY_CLI_PATH: "/private/railway",
        PINTPATH_PRODUCTION_SCALE_ACTIVATE_RUN_ID: PRODUCTION_ACTIVATE_RUN_ID,
        PINTPATH_PRODUCTION_SCALE_ACTIVATION_VERIFICATION_FILE:
          activationVerificationFile,
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      validateCli: () => true,
      validateProductionActivationPrerequisite: vi.fn(() => ({
        candidateSha: CANDIDATE_SHA,
        consumer: { runId: PRODUCTION_SCALE_RUN_ID },
        activation: {
          runId: PRODUCTION_ACTIVATE_RUN_ID,
          terminalSha256: "1".repeat(64),
          prerequisitesSha256: "2".repeat(64),
          deploymentBeforeIdSha256: preActivationDeploymentIdSha256,
          deploymentAfterIdSha256: activationDeploymentIdSha256,
        },
      } as unknown as ProductionScaleActivationPrerequisiteVerification)),
      runCommand,
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(0);
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith(
      "/private/railway",
      [
        "service", "scale", "asia-southeast1-eqsg3a=2",
        "--project", PROJECT_ID,
        "--environment", PRODUCTION_ENVIRONMENT_ID,
        "--service", SERVICE_ID,
        "--json",
      ],
      "production-scale-token-long-enough",
    );
    expect(JSON.parse(output[0]!)).toMatchObject({
      direction: "converge-production-two",
      outcome: "scaled",
      desiredReplicas: 2,
      attempts: 1,
      retryAllowed: false,
      checks: {
        productionActivationPrerequisiteExact: true,
        productionActivationDeploymentContinuityExact: true,
        targetPostflightExact: true,
        deploymentUnchanged: true,
      },
      productionActivationPrerequisite: {
        runId: PRODUCTION_ACTIVATE_RUN_ID,
        verificationSha256: sha256("{}\n"),
        deploymentAfterIdSha256: activationDeploymentIdSha256,
      },
    });
  });

  it("blocks a D2 generation drift after intent and immediately before service scale", async () => {
    const evidenceDirectory = fs.realpathSync(fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-production-scale-prewrite-drift-test-"),
    ));
    temporaryRoots.push(evidenceDirectory);
    const activationVerificationFile = path.join(
      evidenceDirectory,
      "production-scale-activation-verification.json",
    );
    fs.writeFileSync(activationVerificationFile, "{}\n", { mode: 0o600 });
    const activationDeploymentIdSha256 = railwayDeploymentIdentityIdSha256(
      "deployment",
      DEPLOYMENT_ID,
    )!;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope(PRODUCTION_ENVIRONMENT_ID))
      .mockResolvedValueOnce(scope(PRODUCTION_ENVIRONMENT_ID))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(
        1,
        PRODUCTION_ENVIRONMENT_ID,
        "pintpath.au",
      ))
      .mockResolvedValueOnce(discovery(DRIFT_DEPLOYMENT_ID))
      .mockResolvedValueOnce(snapshot(
        1,
        PRODUCTION_ENVIRONMENT_ID,
        "pintpath.au",
        CANDIDATE_SHA,
        DRIFT_DEPLOYMENT_ID,
        DRIFT_SNAPSHOT_ID,
      ));
    const runCommand = vi.fn();
    const output: string[] = [];

    const result = await runProtectedPermanentStagingScale({
      argv: [
        "--direction", "converge-production-two",
        "--candidate-sha", CANDIDATE_SHA,
        "--expected-deployment-sha", CANDIDATE_SHA,
        "--evidence-dir", evidenceDirectory,
        "--production-activation-run-id", PRODUCTION_ACTIVATE_RUN_ID,
        "--production-scale-verification-file", activationVerificationFile,
      ],
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_RUN_ID: PRODUCTION_SCALE_RUN_ID,
        GITHUB_SHA: CANDIDATE_SHA,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_SCALE_CONFIRMATION: "CONVERGE_PRODUCTION_TO_TWO_REPLICAS",
        PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN:
          "production-metadata-token-long-enough",
        PINTPATH_RAILWAY_PRODUCTION_SCALE_TOKEN:
          "production-scale-token-long-enough",
        PINTPATH_RAILWAY_CLI_PATH: "/private/railway",
        PINTPATH_PRODUCTION_SCALE_ACTIVATE_RUN_ID: PRODUCTION_ACTIVATE_RUN_ID,
        PINTPATH_PRODUCTION_SCALE_ACTIVATION_VERIFICATION_FILE:
          activationVerificationFile,
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      validateCli: () => true,
      validateProductionActivationPrerequisite: vi.fn(() => ({
        candidateSha: CANDIDATE_SHA,
        consumer: { runId: PRODUCTION_SCALE_RUN_ID },
        activation: {
          runId: PRODUCTION_ACTIVATE_RUN_ID,
          terminalSha256: "1".repeat(64),
          prerequisitesSha256: "2".repeat(64),
          deploymentBeforeIdSha256: "3".repeat(64),
          deploymentAfterIdSha256: activationDeploymentIdSha256,
        },
      } as unknown as ProductionScaleActivationPrerequisiteVerification)),
      runCommand,
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(1);
    expect(runCommand).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: {
        durableIntentExact: true,
        targetPreflightExact: false,
        productionActivationDeploymentContinuityExact: false,
        writeAttemptedAtMostOnce: true,
      },
    });
  });

  it("rejects production convergence unless the observed deployment SHA is the candidate", async () => {
    const fetchImpl = vi.fn();
    const runCommand = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: [
        "--direction", "converge-production-two",
        "--candidate-sha", CANDIDATE_SHA,
        "--expected-deployment-sha", "b".repeat(40),
        "--evidence-dir", "/private/evidence",
      ],
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE_SHA,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_SCALE_CONFIRMATION: "CONVERGE_PRODUCTION_TO_TWO_REPLICAS",
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn(),
      reassertRepositoryState: () => true,
      validateCli: () => true,
      runCommand,
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      candidateSha: null,
    });
  });

  it("blocks production scale before the write when activation names another deployment", async () => {
    const evidenceDirectory = fs.realpathSync(fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-production-scale-drift-test-"),
    ));
    temporaryRoots.push(evidenceDirectory);
    const activationVerificationFile = path.join(
      evidenceDirectory,
      "production-scale-activation-verification.json",
    );
    fs.writeFileSync(activationVerificationFile, "{}\n", { mode: 0o600 });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope(PRODUCTION_ENVIRONMENT_ID))
      .mockResolvedValueOnce(scope(PRODUCTION_ENVIRONMENT_ID))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(
        1,
        PRODUCTION_ENVIRONMENT_ID,
        "pintpath.au",
      ));
    const runCommand = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: [
        "--direction", "converge-production-two",
        "--candidate-sha", CANDIDATE_SHA,
        "--expected-deployment-sha", CANDIDATE_SHA,
        "--evidence-dir", evidenceDirectory,
      ],
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_RUN_ID: PRODUCTION_SCALE_RUN_ID,
        GITHUB_SHA: CANDIDATE_SHA,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_SCALE_CONFIRMATION: "CONVERGE_PRODUCTION_TO_TWO_REPLICAS",
        PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN:
          "production-metadata-token-long-enough",
        PINTPATH_RAILWAY_PRODUCTION_SCALE_TOKEN:
          "production-scale-token-long-enough",
        PINTPATH_RAILWAY_CLI_PATH: "/private/railway",
        PINTPATH_PRODUCTION_SCALE_ACTIVATE_RUN_ID: PRODUCTION_ACTIVATE_RUN_ID,
        PINTPATH_PRODUCTION_SCALE_ACTIVATION_VERIFICATION_FILE:
          activationVerificationFile,
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      validateCli: () => true,
      validateProductionActivationPrerequisite: vi.fn(() => ({
        candidateSha: CANDIDATE_SHA,
        consumer: { runId: PRODUCTION_SCALE_RUN_ID },
        activation: {
          runId: PRODUCTION_ACTIVATE_RUN_ID,
          terminalSha256: "1".repeat(64),
          prerequisitesSha256: "2".repeat(64),
          deploymentBeforeIdSha256: "3".repeat(64),
          deploymentAfterIdSha256: "4".repeat(64),
        },
      } as unknown as ProductionScaleActivationPrerequisiteVerification)),
      runCommand,
      probeRuntime: vi.fn(),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(1);
    expect(runCommand).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: {
        productionActivationPrerequisiteExact: true,
        productionActivationDeploymentContinuityExact: false,
      },
    });
  });

  it("blocks a scale-out rerun before any provider read or write", async () => {
    const fetchImpl = vi.fn();
    const runCommand = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out", { GITHUB_RUN_ATTEMPT: "2" }),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn(),
      reassertRepositoryState: () => true,
      validateCli: () => true,
      runCommand,
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: { githubAuthorityExact: false },
    });
  });
});
