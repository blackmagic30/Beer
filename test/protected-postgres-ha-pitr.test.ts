import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  POSTGRES_HA_PITR_ENABLE,
  POSTGRES_HA_PITR_HEALTH,
  POSTGRES_HA_PITR_INVENTORY,
  POSTGRES_HA_PITR_PROGRESS,
  POSTGRES_HA_PITR_SCOPE,
  runProtectedPostgresHaPitr,
} from "../scripts/execute-protected-postgres-ha-pitr.js";

const CANDIDATE = "a".repeat(40);
const PROJECT = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT = "13dab015-df74-45c6-b26f-69323daea99a";
const ROOT = "11111111-1111-4111-8111-111111111111";
const REPLICA = "22222222-2222-4222-8222-222222222222";
const WORKFLOW = "33333333-3333-4333-8333-333333333333";
const UNTRUSTED_ROOT = "44444444-4444-4444-8444-444444444444";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function scope(): Response {
  return json({
    data: { projectToken: { projectId: PROJECT, environmentId: ENVIRONMENT } },
  });
}
function inventory(): Response {
  return json({
    data: {
      environment: {
        id: ENVIRONMENT,
        projectId: PROJECT,
        serviceInstances: {
          edges: [
            { node: { environmentId: ENVIRONMENT, serviceId: ROOT } },
            { node: { environmentId: ENVIRONMENT, serviceId: REPLICA } },
          ],
          pageInfo: { hasNextPage: false, endCursor: "inventory-end" },
        },
      },
    },
  });
}
function notHaRoot(): Response {
  return json({ data: { pitrHaClusterReplicationHealth: null } });
}
function inventoryWithUntrustedRoot(): Response {
  return json({
    data: {
      environment: {
        id: ENVIRONMENT,
        projectId: PROJECT,
        serviceInstances: {
          edges: [
            {
              node: {
                environmentId: ENVIRONMENT,
                serviceId: UNTRUSTED_ROOT,
              },
            },
            { node: { environmentId: ENVIRONMENT, serviceId: REPLICA } },
          ],
          pageInfo: { hasNextPage: false, endCursor: "inventory-end" },
        },
      },
    },
  });
}
function untrustedRootHealth(): Response {
  return json({
    data: {
      pitrHaClusterReplicationHealth: {
        allHealthy: true,
        checkedAt: "2026-08-13T12:00:00Z",
        environmentId: ENVIRONMENT,
        reachable: true,
        rootServiceId: UNTRUSTED_ROOT,
        members: [
          {
            healthy: true,
            isLeader: true,
            lagMb: 0,
            patroniName: "untrusted-leader",
            serviceId: UNTRUSTED_ROOT,
            serviceName: "postgres",
            state: "running",
          },
          {
            healthy: true,
            isLeader: false,
            lagMb: 0,
            patroniName: "replica",
            serviceId: REPLICA,
            serviceName: "postgres-replica",
            state: "streaming",
          },
        ],
      },
    },
  });
}
function argv(targetEnvironment = "production"): string[] {
  return [
    "--candidate-sha",
    CANDIDATE,
    "--target-environment",
    targetEnvironment,
    "--evidence-dir",
    "/private/evidence",
  ];
}
function environment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CANDIDATE,
    GITHUB_RUN_ATTEMPT: "1",
    PINTPATH_POSTGRES_HA_PITR_CONFIRMATION: "ENABLE_PITR_PRODUCTION",
    PINTPATH_POSTGRES_HA_PITR_AUTHORITY_TARGET: "production",
    PINTPATH_POSTGRES_HA_PITR_EXPECTED_ROOT_SERVICE_ID: ROOT,
    PINTPATH_RAILWAY_PITR_METADATA_TOKEN: "pitr-metadata-token-long-enough",
    PINTPATH_RAILWAY_PITR_ENABLE_TOKEN: "pitr-enable-token-long-enough",
    ...overrides,
  };
}
function health(): Response {
  return json({
    data: {
      pitrHaClusterReplicationHealth: {
        allHealthy: true,
        checkedAt: "2026-08-13T12:00:00Z",
        environmentId: ENVIRONMENT,
        reachable: true,
        rootServiceId: ROOT,
        members: [
          {
            healthy: true,
            isLeader: true,
            lagMb: 0,
            patroniName: "leader",
            serviceId: ROOT,
            serviceName: "postgres",
            state: "running",
          },
          {
            healthy: true,
            isLeader: false,
            lagMb: 0,
            patroniName: "replica",
            serviceId: REPLICA,
            serviceName: "postgres-replica",
            state: "streaming",
          },
        ],
      },
    },
  });
}
function progress(): Response {
  return json({
    data: {
      pitrHaWorkflowProgress: {
        workflowId: WORKFLOW,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        rootServiceId: ROOT,
        direction: "ENABLE",
        phase: "DONE",
        clusterMutated: true,
        startedAt: "2026-08-13T12:00:00Z",
        updatedAt: "2026-08-13T12:05:00Z",
        completedAt: "2026-08-13T12:05:00Z",
        currentMemberServiceId: null,
        newLeaderServiceId: ROOT,
        errorMessage: null,
        failedAtPhase: null,
        members: [
          {
            serviceId: ROOT,
            serviceName: "postgres",
            isLeader: true,
            status: "HEALTHY",
          },
          {
            serviceId: REPLICA,
            serviceName: "postgres-replica",
            isLeader: false,
            status: "HEALTHY",
          },
        ],
      },
    },
  });
}

function failedProgress(): Response {
  return json({
    data: {
      pitrHaWorkflowProgress: {
        workflowId: WORKFLOW,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        rootServiceId: ROOT,
        direction: "ENABLE",
        phase: "FAILED",
        clusterMutated: true,
        startedAt: "2026-08-13T12:00:00Z",
        updatedAt: "2026-08-13T12:01:00Z",
        completedAt: null,
        currentMemberServiceId: ROOT,
        newLeaderServiceId: null,
        errorMessage: "provider workflow failed",
        failedAtPhase: "ROLLING_REPLICAS",
        members: [
          {
            serviceId: ROOT,
            serviceName: "postgres",
            isLeader: true,
            status: "HEALTHY",
          },
          {
            serviceId: REPLICA,
            serviceName: "postgres-replica",
            isLeader: false,
            status: "PENDING",
          },
        ],
      },
    },
  });
}

describe("protected Railway Postgres HA PITR", () => {
  it("pins metadata-only preflight/postflight and one reviewed mutation", () => {
    expect(POSTGRES_HA_PITR_SCOPE).not.toMatch(/mutation\s/i);
    expect(POSTGRES_HA_PITR_INVENTORY).not.toMatch(/mutation\s/i);
    expect(POSTGRES_HA_PITR_HEALTH).not.toMatch(/mutation\s/i);
    expect(POSTGRES_HA_PITR_PROGRESS).not.toMatch(/mutation\s/i);
    expect(POSTGRES_HA_PITR_ENABLE).toContain("enablePitrForHaCluster");
    expect(POSTGRES_HA_PITR_ENABLE).toContain("EnablePitrForHaClusterInput");
  });

  it("enables one exact healthy HA root once and reconciles DONE", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(inventory())
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(notHaRoot())
      .mockResolvedValueOnce(json({ data: { pitrHaWorkflowProgress: null } }))
      .mockResolvedValueOnce(
        json({
          data: {
            enablePitrForHaCluster: {
              projectId: PROJECT,
              workflowId: WORKFLOW,
            },
          },
        }),
      )
      .mockResolvedValueOnce(progress())
      .mockResolvedValueOnce(health());
    const output: string[] = [];
    const writes: string[] = [];
    const runBoundary = vi.fn().mockResolvedValue(true);
    const result = await runProtectedPostgresHaPitr({
      argv: argv(),
      env: environment(),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      runBoundary,
      writeDurable: (_directory, _leaf, source) => {
        writes.push(source);
        return crypto.createHash("sha256").update(source).digest("hex");
      },
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(0);
    expect(runBoundary).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(
      fetchImpl.mock.calls.filter((call) =>
        String((call[1] as RequestInit).body).includes(
          "enablePitrForHaCluster",
        ),
      ),
    ).toHaveLength(1);
    expect(writes.join("\n")).not.toContain("pitr-enable-token");
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "enabled",
      attempts: 1,
      retryAllowed: false,
      targetEnvironment: "production",
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      rootServiceId: ROOT,
      targetAuthoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      checks: {
        protectedTargetAuthorityExact: true,
        providerRootAuthorityExact: true,
        healthPreflightExact: true,
        priorWorkflowAbsent: true,
        boundaryPreflightExact: true,
        acknowledgementExact: true,
        postflightAttempted: true,
        workflowDoneExact: true,
        healthPostflightExact: true,
        boundaryPostflightExact: true,
        terminalEvidenceExact: true,
      },
    });
  });

  it("blocks an unknown target selector before provider access", async () => {
    const fetchImpl = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPostgresHaPitr({
      argv: argv("development"),
      env: environment(),
      cwd: process.cwd(),
      fetchImpl,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: { targetExact: false, postflightAttempted: false },
    });
  });

  it("blocks a protected authority copied into the wrong target environment", async () => {
    const fetchImpl = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPostgresHaPitr({
      argv: argv(),
      env: environment({
        PINTPATH_POSTGRES_HA_PITR_AUTHORITY_TARGET: "permanent-staging",
      }),
      cwd: process.cwd(),
      fetchImpl,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: { protectedTargetAuthorityExact: false },
    });
  });

  it("independently discovers and rejects a provider root that differs from protected authority", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(inventoryWithUntrustedRoot())
      .mockResolvedValueOnce(untrustedRootHealth())
      .mockResolvedValueOnce(notHaRoot());
    const output: string[] = [];
    const result = await runProtectedPostgresHaPitr({
      argv: argv(),
      env: environment(),
      cwd: process.cwd(),
      fetchImpl,
      runBoundary: vi.fn(),
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(
      fetchImpl.mock.calls.some((call) =>
        String((call[1] as RequestInit).body).includes(
          "enablePitrForHaCluster",
        ),
      ),
    ).toBe(false);
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      rootServiceId: ROOT,
      checks: {
        protectedTargetAuthorityExact: true,
        providerRootAuthorityExact: false,
        durableIntentExact: false,
      },
    });
  });

  it("reconciles a lost PITR acknowledgement without retrying", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(inventory())
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(notHaRoot())
      .mockResolvedValueOnce(json({ data: { pitrHaWorkflowProgress: null } }))
      .mockRejectedValueOnce(new Error("connection_lost_after_send"))
      .mockResolvedValueOnce(progress())
      .mockResolvedValueOnce(health());
    const runBoundary = vi.fn().mockResolvedValue(true);
    const output: string[] = [];
    const result = await runProtectedPostgresHaPitr({
      argv: argv(),
      env: environment(),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      runBoundary,
      writeDurable: (_directory, _leaf, source) =>
        crypto.createHash("sha256").update(source).digest("hex"),
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(runBoundary).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.filter((call) =>
        String((call[1] as RequestInit).body).includes(
          "enablePitrForHaCluster",
        ),
      ),
    ).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: 1,
      checks: {
        acknowledgementExact: false,
        workflowDoneExact: true,
        boundaryPostflightExact: true,
      },
    });
  });

  it("stops immediately on an explicit provider FAILED terminal state", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(inventory())
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(notHaRoot())
      .mockResolvedValueOnce(json({ data: { pitrHaWorkflowProgress: null } }))
      .mockResolvedValueOnce(
        json({
          data: {
            enablePitrForHaCluster: {
              projectId: PROJECT,
              workflowId: WORKFLOW,
            },
          },
        }),
      )
      .mockResolvedValueOnce(failedProgress());
    const output: string[] = [];
    const sleep = vi.fn();
    const runBoundary = vi.fn().mockResolvedValue(true);
    const result = await runProtectedPostgresHaPitr({
      argv: argv(),
      env: environment(),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep,
      runBoundary,
      writeDurable: (_directory, _leaf, source) =>
        crypto.createHash("sha256").update(source).digest("hex"),
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(runBoundary).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: 1,
      checks: { postflightAttempted: true, workflowDoneExact: false },
    });
  });
});
