import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  DISPOSABLE_RESTORE_DELETE_MUTATION,
  DISPOSABLE_RESTORE_INVENTORY_QUERY,
  protectedDisposableRestoreTeardownInternals,
  runProtectedDisposableRestoreTeardown,
} from "../scripts/execute-protected-disposable-restore-teardown.js";
import { runDisposableRestoreAbsenceVerification } from "../scripts/verify-disposable-restore-project-absent.js";

const CANDIDATE = "a".repeat(40);
const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const SERVICE = "33333333-3333-4333-8333-333333333333";
const INSTANCE = "44444444-4444-4444-8444-444444444444";
const VOLUME = "55555555-5555-4555-8555-555555555555";
const VOLUME_INSTANCE = "66666666-6666-4666-8666-666666666666";
const BUCKET = "77777777-7777-4777-8777-777777777777";
const NAME = "pintpath-disposable-restore-20260813";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function page(edges: unknown[]) {
  return {
    edges,
    pageInfo: { hasNextPage: false, endCursor: edges.length ? "end" : null },
  };
}
function providerInventory(): Record<string, unknown> {
  return {
    data: {
      projectsByIds: [
        {
          id: PROJECT,
          name: NAME,
          isTempProject: true,
          baseEnvironmentId: ENVIRONMENT,
          primaryEnvironmentId: ENVIRONMENT,
          environments: page([
            {
              node: {
                id: ENVIRONMENT,
                name: NAME,
                projectId: PROJECT,
                isEphemeral: true,
                serviceInstances: page([
                  {
                    node: {
                      id: INSTANCE,
                      serviceId: SERVICE,
                      serviceName: "postgres-restored",
                      environmentId: ENVIRONMENT,
                    },
                  },
                ]),
                volumeInstances: page([
                  {
                    node: {
                      id: VOLUME_INSTANCE,
                      serviceId: SERVICE,
                      environmentId: ENVIRONMENT,
                      volume: {
                        id: VOLUME,
                        name: "restore-data",
                        projectId: PROJECT,
                      },
                    },
                  },
                ]),
              },
            },
          ]),
          services: page([
            {
              node: {
                id: SERVICE,
                name: "postgres-restored",
                projectId: PROJECT,
              },
            },
          ]),
          volumes: page([
            { node: { id: VOLUME, name: "restore-data", projectId: PROJECT } },
          ]),
          buckets: page([
            {
              node: {
                id: BUCKET,
                name: "restore-evidence",
                projectId: PROJECT,
              },
            },
          ]),
        },
      ],
    },
  };
}
function args(inventorySha256: string): string[] {
  return [
    "--candidate-sha",
    CANDIDATE,
    "--project-id",
    PROJECT,
    "--project-name",
    NAME,
    "--environment-id",
    ENVIRONMENT,
    "--environment-name",
    NAME,
    "--inventory-sha256",
    inventorySha256,
    "--evidence-dir",
    "/private/evidence",
  ];
}

describe("protected disposable restore teardown", () => {
  it("pins complete metadata reads and one projectDelete mutation", () => {
    expect(DISPOSABLE_RESTORE_INVENTORY_QUERY).toContain("projectsByIds");
    expect(DISPOSABLE_RESTORE_INVENTORY_QUERY).toContain(
      "serviceInstances(first:100)",
    );
    expect(DISPOSABLE_RESTORE_INVENTORY_QUERY).toContain(
      "volumeInstances(first:100)",
    );
    expect(DISPOSABLE_RESTORE_INVENTORY_QUERY).not.toMatch(/mutation\s/i);
    expect(DISPOSABLE_RESTORE_DELETE_MUTATION).toContain(
      "projectDelete(id:$projectId)",
    );
  });

  it("deletes one exact separate disposable project once and proves absence", async () => {
    const parsed = protectedDisposableRestoreTeardownInternals.inventory(
      providerInventory(),
      protectedDisposableRestoreTeardownInternals.parseArgs(
        args("f".repeat(64)),
      )!,
    );
    expect(parsed).not.toBeNull();
    const inventorySha = sha256(`${JSON.stringify(parsed, null, 2)}\n`);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json({ data: { projectDelete: true } }))
      .mockResolvedValueOnce(json({ data: { projectsByIds: [] } }));
    const outputs: string[] = [];
    const writes: string[] = [];
    const runBoundary = vi.fn().mockResolvedValue(true);
    const result = await runProtectedDisposableRestoreTeardown({
      argv: args(inventorySha),
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_RESTORE_TEARDOWN_CONFIRMATION: `DELETE_${PROJECT}`,
        PINTPATH_RAILWAY_RESTORE_METADATA_TOKEN:
          "restore-metadata-token-long-enough",
        PINTPATH_RAILWAY_RESTORE_DELETE_TOKEN:
          "restore-delete-token-long-enough",
      },
      cwd: process.cwd(),
      fetchImpl,
      runBoundary,
      writeDurable: (_directory, _leaf, source) => {
        writes.push(source);
        return sha256(source);
      },
      writeOutput: (source) => outputs.push(source),
    });
    expect(result).toBe(0);
    expect(runBoundary).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(
      fetchImpl.mock.calls.filter((call) =>
        String((call[1] as RequestInit).body).includes("projectDelete"),
      ),
    ).toHaveLength(1);
    expect(writes.join("\n")).not.toContain("restore-delete-token");
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "deleted",
      attempts: 1,
      retryAllowed: false,
      checks: {
        targetNotProtected: true,
        inventoryExact: true,
        boundaryPreflightExact: true,
        acknowledgementExact: true,
        postflightAttempted: true,
        targetAbsentExact: true,
        boundaryPostflightExact: true,
        terminalEvidenceExact: true,
      },
    });
  });

  it("blocks the canonical Pint Path project before provider access", async () => {
    const fetchImpl = vi.fn();
    const output: string[] = [];
    const canonicalProjectArgs = args("f".repeat(64));
    canonicalProjectArgs[3] = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
    await runProtectedDisposableRestoreTeardown({
      argv: canonicalProjectArgs,
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_RESTORE_TEARDOWN_CONFIRMATION:
          "DELETE_48d8c6cd-1c66-4148-874b-20877f48e1a5",
      },
      cwd: process.cwd(),
      fetchImpl,
      writeOutput: (source) => output.push(source),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: { targetNotProtected: false, postflightAttempted: false },
    });
  });

  it("reconciles a lost delete acknowledgement without retrying", async () => {
    const parsed = protectedDisposableRestoreTeardownInternals.inventory(
      providerInventory(),
      protectedDisposableRestoreTeardownInternals.parseArgs(
        args("f".repeat(64)),
      )!,
    );
    const inventorySha = sha256(`${JSON.stringify(parsed, null, 2)}\n`);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json(providerInventory()))
      .mockRejectedValueOnce(new Error("connection_lost_after_send"))
      .mockResolvedValueOnce(json({ data: { projectsByIds: [] } }));
    const runBoundary = vi.fn().mockResolvedValue(true);
    const outputs: string[] = [];
    const result = await runProtectedDisposableRestoreTeardown({
      argv: args(inventorySha),
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_RESTORE_TEARDOWN_CONFIRMATION: `DELETE_${PROJECT}`,
        PINTPATH_RAILWAY_RESTORE_METADATA_TOKEN:
          "restore-metadata-token-long-enough",
        PINTPATH_RAILWAY_RESTORE_DELETE_TOKEN:
          "restore-delete-token-long-enough",
      },
      cwd: process.cwd(),
      fetchImpl,
      runBoundary,
      writeDurable: (_directory, _leaf, source) => sha256(source),
      writeOutput: (source) => outputs.push(source),
    });
    expect(result).toBe(1);
    expect(runBoundary).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.filter((call) =>
        String((call[1] as RequestInit).body).includes("projectDelete"),
      ),
    ).toHaveLength(1);
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: 1,
      checks: {
        acknowledgementExact: false,
        targetAbsentExact: true,
        boundaryPostflightExact: true,
      },
    });
  });

  it("provides an independent workflow-level exact absence postflight", async () => {
    const output: string[] = [];
    const result = await runDisposableRestoreAbsenceVerification(
      args("f".repeat(64)),
      "restore-metadata-token-long-enough",
      vi.fn().mockResolvedValue(json({ data: { projectsByIds: [] } })),
      (source) => output.push(source),
    );
    expect(result).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      absent: true,
    });
  });
});
