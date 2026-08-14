import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { verifyGithubPermanentStagingDeployment } from
  "../scripts/verify-github-permanent-staging-deployment.mjs";

const CANDIDATE = "a".repeat(40);
const REPLACEMENT_RUN_ID = "100";
const DEPLOYMENT_RUN_ID = "200";
const CUTOVER_RUN_ID = "300";
const REPOSITORY = "blackmagic30/Beer";
const REPLACEMENT_WORKFLOW =
  ".github/workflows/permanent-staging-provider-mutation.yml";
const DEPLOYMENT_WORKFLOW =
  ".github/workflows/deploy-permanent-staging.yml";
const CUTOVER_WORKFLOW =
  ".github/workflows/permanent-staging-supabase-legacy-cutover.yml";

type WorkflowRun = {
  id: number;
  repository: { full_name: string };
  head_repository: { full_name: string };
  head_sha: string;
  head_branch: string;
  path: string;
  event: string;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at: string;
  updated_at: string;
};

function run(
  id: number,
  path: string,
  status: string,
  conclusion: string | null,
  startedAt: string,
  updatedAt: string,
): WorkflowRun {
  return {
    id,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    head_sha: CANDIDATE,
    head_branch: "main",
    path: `${path}@main`,
    event: "workflow_dispatch",
    run_attempt: 1,
    status,
    conclusion,
    created_at: startedAt,
    run_started_at: startedAt,
    updated_at: updatedAt,
  };
}

function artifact(name: string, runId: number) {
  const id = runId * 100;
  return {
    id,
    name,
    expired: false,
    size_in_bytes: 4096,
    digest: `sha256:${crypto.createHash("sha256").update(name).digest("hex")}`,
    archive_download_url:
      `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${id}/zip`,
    workflow_run: { id: runId, head_sha: CANDIDATE },
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function failedBeforeWriteJobs(runId: number, mutationConclusion = "skipped") {
  return {
    total_count: 1,
    jobs: [{
      run_id: runId,
      run_attempt: 1,
      name: "Deploy permanent staging",
      status: "completed",
      conclusion: "failure",
      steps: [{
        name: "Execute one permanent-staging source upload and reconcile it",
        status: "completed",
        conclusion: mutationConclusion,
      }],
    }],
  };
}

function harness(options: {
  current?: Partial<WorkflowRun>;
  replacement?: Partial<WorkflowRun>;
  deployment?: Partial<WorkflowRun>;
  replacementListing?: unknown;
  deploymentListing?: unknown;
  replacementRuns?: WorkflowRun[];
  deploymentRuns?: WorkflowRun[];
  failedRunJobs?: Record<string, unknown>;
  env?: Record<string, string>;
} = {}) {
  const current = {
    ...run(
      Number(CUTOVER_RUN_ID),
      CUTOVER_WORKFLOW,
      "in_progress",
      null,
      "2026-08-14T03:00:00.000Z",
      "2026-08-14T03:00:01.000Z",
    ),
    ...options.current,
  };
  const replacement = {
    ...run(
      Number(REPLACEMENT_RUN_ID),
      REPLACEMENT_WORKFLOW,
      "completed",
      "success",
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T01:00:00.000Z",
    ),
    ...options.replacement,
  };
  const deployment = {
    ...run(
      Number(DEPLOYMENT_RUN_ID),
      DEPLOYMENT_WORKFLOW,
      "completed",
      "success",
      "2026-08-14T01:01:00.000Z",
      "2026-08-14T02:00:00.000Z",
    ),
    ...options.deployment,
  };
  const replacementName =
    `pintpath-permanent-staging-provider-mutation-supabase-key-replacement-${CANDIDATE}`;
  const deploymentName = `pintpath-permanent-staging-deployment-${CANDIDATE}`;
  const replacementListing = options.replacementListing ?? {
    total_count: 1,
    artifacts: [artifact(replacementName, Number(REPLACEMENT_RUN_ID))],
  };
  const deploymentListing = options.deploymentListing ?? {
    total_count: 1,
    artifacts: [artifact(deploymentName, Number(DEPLOYMENT_RUN_ID))],
  };
  const deploymentRuns = options.deploymentRuns ?? [deployment];
  const replacementRuns = options.replacementRuns ?? [replacement];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith(`/actions/runs/${CUTOVER_RUN_ID}`)) return json(current);
    if (url.endsWith(`/actions/runs/${REPLACEMENT_RUN_ID}`)) {
      return json(replacement);
    }
    if (url.endsWith(`/actions/runs/${DEPLOYMENT_RUN_ID}`)) {
      return json(deployment);
    }
    if (url.includes("/actions/workflows/permanent-staging-provider-mutation.yml/runs?")) {
      return json({
        total_count: replacementRuns.length,
        workflow_runs: replacementRuns,
      });
    }
    if (url.includes("/actions/workflows/deploy-permanent-staging.yml/runs?")) {
      return json({
        total_count: deploymentRuns.length,
        workflow_runs: deploymentRuns,
      });
    }
    const jobsMatch = /\/actions\/runs\/(\d+)\/jobs\?/.exec(url);
    if (jobsMatch) {
      return json(options.failedRunJobs?.[jobsMatch[1]!] ?? {
        total_count: 0,
        jobs: [],
      });
    }
    if (
      url ===
      `https://api.github.com/repos/${REPOSITORY}/actions/runs/${REPLACEMENT_RUN_ID}/artifacts?name=${encodeURIComponent(replacementName)}&per_page=100`
    ) {
      return json(replacementListing);
    }
    if (
      url ===
      `https://api.github.com/repos/${REPOSITORY}/actions/runs/${DEPLOYMENT_RUN_ID}/artifacts?name=${encodeURIComponent(deploymentName)}&per_page=100`
    ) {
      return json(deploymentListing);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CANDIDATE,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_RUN_ID: CUTOVER_RUN_ID,
    GITHUB_TOKEN: "github-token-long-enough", // security-scan allow: synthetic no-call fixture
    ...options.env,
  };
  return {
    fetchImpl,
    verify: () => verifyGithubPermanentStagingDeployment({
      candidateSha: CANDIDATE,
      replacementRunId: REPLACEMENT_RUN_ID,
      deploymentRunId: DEPLOYMENT_RUN_ID,
      env,
      fetchImpl,
      requestTimeoutMs: 1_000,
    }),
  };
}

describe("GitHub permanent-staging deployment authority", () => {
  it("binds the successful atomic replacement and later deployment artifacts before cutover", async () => {
    const { fetchImpl, verify } = harness();
    const authority = await verify();

    expect(authority).toEqual(expect.objectContaining({
      schemaVersion: 1,
      kind: "pintpath-github-permanent-staging-deployment-authority",
      repository: REPOSITORY,
      candidateSha: CANDIDATE,
      consumerWorkflowRunId: CUTOVER_RUN_ID,
      replacementWorkflowRunId: REPLACEMENT_RUN_ID,
      replacementWorkflowConclusion: "success",
      replacementWorkflowRunCreatedAt: "2026-08-14T00:00:00.000Z",
      deploymentWorkflowRunId: DEPLOYMENT_RUN_ID,
      deploymentWorkflowConclusion: "success",
      replacementPrecedesDeployment: true,
      deploymentPrecedesCutover: true,
    }));
    expect(authority.replacementArtifactName).toBe(
      `pintpath-permanent-staging-provider-mutation-supabase-key-replacement-${CANDIDATE}`,
    );
    expect(authority.deploymentArtifactName).toBe(
      `pintpath-permanent-staging-deployment-${CANDIDATE}`,
    );
    expect(authority).toMatchObject({
      deploymentWindowExact: true,
      failedBeforeWriteDeploymentRunIds: [],
      replacementWindowExact: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it.each([
    ["replacement workflow", { replacement: { path: DEPLOYMENT_WORKFLOW } }],
    [
      "replacement workflow ref",
      { replacement: { path: `${REPLACEMENT_WORKFLOW}@feature` } },
    ],
    ["replacement operation run", { replacement: { conclusion: "failure" } }],
    ["deployment candidate", { deployment: { head_sha: "b".repeat(40) } }],
    ["deployment attempt", { deployment: { run_attempt: 2 } }],
    ["cutover workflow", { current: { path: DEPLOYMENT_WORKFLOW } }],
    ["cutover attempt", { current: { run_attempt: 2 } }],
  ])("rejects a substituted %s", async (_label, options) => {
    await expect(harness(options).verify()).rejects.toThrow(
      /github_permanent_staging_deployment_(?:replacement|deployment|consumer)_run_invalid/,
    );
  });

  it("requires exact, unique, unexpired artifacts from both authenticated runs", async () => {
    await expect(harness({
      replacementListing: { total_count: 0, artifacts: [] },
    }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_artifact_invalid",
    );

    const name = `pintpath-permanent-staging-deployment-${CANDIDATE}`;
    const wrong = artifact(name, Number(DEPLOYMENT_RUN_ID));
    wrong.workflow_run.head_sha = "b".repeat(40);
    await expect(harness({
      deploymentListing: { total_count: 1, artifacts: [wrong] },
    }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_artifact_invalid",
    );

    const duplicate = artifact(name, Number(DEPLOYMENT_RUN_ID) + 1);
    await expect(harness({
      deploymentListing: { total_count: 2, artifacts: [duplicate, duplicate] },
    }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_artifact_invalid",
    );
  });

  it("requires replacement completion before deployment and deployment completion before cutover", async () => {
    await expect(harness({
      replacement: { updated_at: "2026-08-14T01:01:00.000Z" },
    }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_chronology_invalid",
    );
    await expect(harness({
      deployment: { updated_at: "2026-08-14T03:00:00.000Z" },
    }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_chronology_invalid",
    );
  });

  it("uses replacement creation as the queue-safe history lower bound", async () => {
    const queued = harness({
      replacement: {
        created_at: "2026-08-14T00:00:00.000Z",
        run_started_at: "2026-08-14T00:30:00.000Z",
      },
    });
    await expect(queued.verify()).resolves.toMatchObject({
      replacementWorkflowRunCreatedAt: "2026-08-14T00:00:00.000Z",
      replacementWorkflowRunStartedAt: "2026-08-14T00:30:00.000Z",
    });
    expect(queued.fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(
        "2026-08-14T00:00:00.000Z..2026-08-14T01:01:00.000Z",
      )),
      expect.anything(),
    );

    await expect(harness({
      replacement: {
        created_at: "2026-08-14T00:31:00.000Z",
        run_started_at: "2026-08-14T00:30:00.000Z",
      },
    }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_chronology_invalid",
    );
  });

  it("allows an approved retry only after an authenticated failure before the write step", async () => {
    const failed = run(
      150,
      DEPLOYMENT_WORKFLOW,
      "completed",
      "failure",
      "2026-08-14T01:00:20.000Z",
      "2026-08-14T01:00:40.000Z",
    );
    const fixture = harness({
      deploymentRuns: [failed, run(
        Number(DEPLOYMENT_RUN_ID),
        DEPLOYMENT_WORKFLOW,
        "completed",
        "success",
        "2026-08-14T01:01:00.000Z",
        "2026-08-14T02:00:00.000Z",
      )],
      failedRunJobs: { "150": failedBeforeWriteJobs(150) },
    });
    await expect(fixture.verify()).resolves.toMatchObject({
      deploymentWindowExact: true,
      failedBeforeWriteDeploymentRunIds: ["150"],
    });

    await expect(harness({
      deploymentRuns: [failed, run(
        Number(DEPLOYMENT_RUN_ID),
        DEPLOYMENT_WORKFLOW,
        "completed",
        "success",
        "2026-08-14T01:01:00.000Z",
        "2026-08-14T02:00:00.000Z",
      )],
      failedRunJobs: { "150": failedBeforeWriteJobs(150, "failure") },
    }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_deployment_window_invalid",
    );
  });

  it("rejects an older, wrong, or intervened deployment selection", async () => {
    const wrong = run(
      199,
      DEPLOYMENT_WORKFLOW,
      "completed",
      "success",
      "2026-08-14T01:01:00.000Z",
      "2026-08-14T01:30:00.000Z",
    );
    await expect(harness({ deploymentRuns: [wrong] }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_deployment_window_invalid",
    );

    const intervening = run(
      250,
      DEPLOYMENT_WORKFLOW,
      "completed",
      "success",
      "2026-08-14T02:10:00.000Z",
      "2026-08-14T02:20:00.000Z",
    );
    await expect(harness({
      deploymentRuns: [run(
        Number(DEPLOYMENT_RUN_ID),
        DEPLOYMENT_WORKFLOW,
        "completed",
        "success",
        "2026-08-14T01:01:00.000Z",
        "2026-08-14T02:00:00.000Z",
      ), intervening],
    }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_deployment_window_invalid",
    );
  });

  it("rejects a later same-candidate provider mutation after the supplied replacement", async () => {
    const laterReplacement = run(
      175,
      REPLACEMENT_WORKFLOW,
      "completed",
      "success",
      "2026-08-14T01:00:10.000Z",
      "2026-08-14T01:00:40.000Z",
    );
    await expect(harness({
      replacementRuns: [run(
        Number(REPLACEMENT_RUN_ID),
        REPLACEMENT_WORKFLOW,
        "completed",
        "success",
        "2026-08-14T00:00:00.000Z",
        "2026-08-14T01:00:00.000Z",
      ), laterReplacement],
    }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_replacement_window_invalid",
    );
  });

  it("rejects an untrusted runtime before making a GitHub request", async () => {
    const { fetchImpl, verify } = harness({
      env: { GITHUB_RUN_ATTEMPT: "2" },
    });
    await expect(verify()).rejects.toThrow(
      "github_permanent_staging_deployment_environment_invalid",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
