import { describe, expect, it } from "vitest";

import { resolveGithubEmergencyCleanupAckArtifact } from "../scripts/resolve-github-production-promotion-recovery-emergency-cleanup-ack.mjs";

const candidate = "a".repeat(40);
const activationRunId = "123456789";
const cleanupRunId = "987654321";
const controllerHeadSha = "b".repeat(40);
const artifactName = `pintpath-production-promotion-recovery-emergency-cleanup-${activationRunId}-railway-delete-ack`;
const env = {
  GITHUB_REPOSITORY: "blackmagic30/Beer",
  GITHUB_TOKEN: "test-token",
  GITHUB_API_URL: "https://api.github.com",
};

function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function artifact(headSha = candidate) {
  return {
    id: 456,
    name: artifactName,
    size_in_bytes: 1024,
    digest: `sha256:${"b".repeat(64)}`,
    expired: false,
    created_at: "2026-08-14T05:00:00Z",
    workflow_run: { id: Number(cleanupRunId), head_sha: headSha },
  };
}

function run(
  path = ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml",
  headSha = candidate,
) {
  return {
    id: Number(cleanupRunId),
    repository: { full_name: "blackmagic30/Beer" },
    path,
    event: "schedule",
    head_sha: headSha,
    head_branch: "main",
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
  };
}

describe("production promotion-recovery emergency cleanup ack artifact resolver", () => {
  it("returns an exact originating cleanup run for a fixed-name acknowledgement", async () => {
    const fetchImpl = async (url: string | URL | Request) =>
      String(url).includes("/actions/artifacts?")
        ? response({ total_count: 1, artifacts: [artifact()] })
        : response(run());
    await expect(
      resolveGithubEmergencyCleanupAckArtifact({
        candidateSha: candidate,
        activationRunId,
        provider: "railway",
        env,
        fetchImpl,
        requestTimeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      found: true,
      artifactName,
      cleanupRunId,
      cleanupWorkflowPath:
        ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml",
    });
  });

  it("recovers candidate-A evidence from an authenticated controller run on protected-main B", async () => {
    const fetchImpl = async (url: string | URL | Request) =>
      String(url).includes("/actions/artifacts?")
        ? response({
            total_count: 1,
            artifacts: [artifact(controllerHeadSha)],
          })
        : response(run(undefined, controllerHeadSha));
    await expect(
      resolveGithubEmergencyCleanupAckArtifact({
        candidateSha: candidate,
        activationRunId,
        provider: "railway",
        env,
        fetchImpl,
        requestTimeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      found: true,
      candidateSha: candidate,
      cleanupRunId,
      cleanupRunHeadSha: controllerHeadSha,
      cleanupWorkflowPath:
        ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml",
    });
  });

  it("keeps a same-run activation acknowledgement exact to armed candidate A", async () => {
    const activationPath =
      ".github/workflows/activate-production-promotion-recovery.yml";
    const activationArtifact = {
      ...artifact(controllerHeadSha),
      workflow_run: {
        id: Number(activationRunId),
        head_sha: controllerHeadSha,
      },
    };
    const fetchImpl = async (url: string | URL | Request) =>
      String(url).includes("/actions/artifacts?")
        ? response({ total_count: 1, artifacts: [activationArtifact] })
        : response({
            ...run(activationPath, controllerHeadSha),
            id: Number(activationRunId),
            event: "workflow_dispatch",
          });
    await expect(
      resolveGithubEmergencyCleanupAckArtifact({
        candidateSha: candidate,
        activationRunId,
        provider: "railway",
        env,
        fetchImpl,
        requestTimeoutMs: 1_000,
      }),
    ).rejects.toThrow("github_emergency_cleanup_ack_run_invalid");
  });

  it("returns found=false only for an exact empty listing", async () => {
    const result = await resolveGithubEmergencyCleanupAckArtifact({
      candidateSha: candidate,
      activationRunId,
      provider: "railway",
      env,
      fetchImpl: async () => response({ total_count: 0, artifacts: [] }),
      requestTimeoutMs: 1_000,
    });
    expect(result).toMatchObject({ found: false, cleanupRunId: null });
  });

  it("rejects a wrong workflow and duplicate artifacts from one run", async () => {
    const wrongWorkflowFetch = async (url: string | URL | Request) =>
      String(url).includes("/actions/artifacts?")
        ? response({ total_count: 1, artifacts: [artifact()] })
        : response(run(".github/workflows/untrusted.yml"));
    await expect(
      resolveGithubEmergencyCleanupAckArtifact({
        candidateSha: candidate,
        activationRunId,
        provider: "railway",
        env,
        fetchImpl: wrongWorkflowFetch,
        requestTimeoutMs: 1_000,
      }),
    ).rejects.toThrow("github_emergency_cleanup_ack_run_invalid");

    await expect(
      resolveGithubEmergencyCleanupAckArtifact({
        candidateSha: candidate,
        activationRunId,
        provider: "railway",
        env,
        fetchImpl: async () =>
          response({
            total_count: 2,
            artifacts: [
              artifact(),
              { ...artifact(), id: 457, created_at: "2026-08-14T05:00:01Z" },
            ],
          }),
        requestTimeoutMs: 1_000,
      }),
    ).rejects.toThrow("github_emergency_cleanup_ack_artifact_ambiguous");
  });
});
