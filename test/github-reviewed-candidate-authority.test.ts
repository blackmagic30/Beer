import { describe, expect, it, vi } from "vitest";

import { verifyGithubReviewedCandidateAuthority } from
  "../scripts/verify-github-reviewed-candidate-authority.mjs";

const CANDIDATE = "a".repeat(40);
const REVIEWED_HEAD = "b".repeat(40);
const TREE = "c".repeat(40);
const REPOSITORY = "blackmagic30/Beer";
const PROVIDER_PATH =
  ".github/workflows/permanent-staging-provider-mutation.yml";
const CUTOVER_PATH =
  ".github/workflows/permanent-staging-supabase-legacy-cutover.yml";
const RUNTIME_PATH = ".github/workflows/configure-runtime-variable.yml";
const DEPLOYMENT_PATH = ".github/workflows/deploy-permanent-staging.yml";
const PROVIDER_OPERATIONS = [
  "provider-google-maps-api-key",
  "provider-google-maps-map-id",
  "provider-google-places-api-key",
  "provider-openai-api-key",
  "supabase-key-replacement",
] as const;

type Run = ReturnType<typeof workflowRun>;

function title(operation: string) {
  return `Permanent staging provider mutation | ${operation} | ${CANDIDATE}`;
}

function workflowRun(input: {
  id: number;
  path: string;
  displayTitle: string;
  status?: string;
  conclusion?: string | null;
  createdAt?: string;
  runAttempt?: number;
}) {
  const createdAt = input.createdAt ?? "2026-08-14T01:00:00.000Z";
  return {
    id: input.id,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    head_sha: CANDIDATE,
    head_branch: "main",
    path: `${input.path}@main`,
    event: "workflow_dispatch",
    display_title: input.displayTitle,
    run_attempt: input.runAttempt ?? 1,
    status: input.status ?? "completed",
    conclusion: input.conclusion === undefined ? "success" : input.conclusion,
    created_at: createdAt,
    run_started_at: createdAt,
    updated_at: "2026-08-14T01:10:00.000Z",
  };
}

function jobs(run: Run, stepConclusion: string) {
  const cutover = run.path.startsWith(CUTOVER_PATH);
  return {
    total_count: 1,
    jobs: [{
      run_id: run.id,
      run_attempt: 1,
      name: cutover
        ? "Disable exact permanent-staging legacy keys"
        : "One atomic variable mutation",
      status: "completed",
      conclusion: run.conclusion,
      steps: [{
        name: cutover
          ? "Canary replacement keys, disable legacy keys once, and reconcile"
          : "Execute exactly one reviewed atomic Railway mutation",
        status: "completed",
        conclusion: stepConclusion,
      }],
    }],
  };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function harness(options: {
  operation?: string;
  current?: Partial<Run>;
  providerRuns?: Run[];
  cutoverRuns?: Run[];
  runtimeRuns?: Run[];
  deploymentRuns?: Run[];
  jobEvidence?: Record<number, unknown>;
  mergedAt?: string;
  replacementRunId?: string | null;
  deployment?: Run;
  deploymentRunId?: string;
  target?: string;
  variableName?: string;
} = {}) {
  const operation = options.operation ?? "supabase-key-replacement";
  const cutover = operation === "supabase-legacy-key-cutover";
  const runtime = operation === "runtime-variable";
  const currentId = cutover ? 600 : runtime ? 650 : 500;
  const target = options.target ?? "permanent-staging";
  const variableName = options.variableName ?? "SUPABASE_URL";
  const current = {
    ...workflowRun({
      id: currentId,
      path: cutover ? CUTOVER_PATH : runtime ? RUNTIME_PATH : PROVIDER_PATH,
      displayTitle: cutover
        ? `Permanent staging Supabase legacy cutover | ${CANDIDATE}`
        : runtime
        ? `Configure runtime variable | ${target} | ${variableName} | ${CANDIDATE}`
        : title(operation),
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    }),
    ...options.current,
  };
  const providerRuns = options.providerRuns ?? (cutover
    ? [workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      createdAt: "2026-08-14T00:45:00.000Z",
    })]
    : [current]);
  const cutoverRuns = options.cutoverRuns ?? (cutover ? [current] : []);
  const runtimeRuns = options.runtimeRuns ?? (runtime ? [current] : []);
  const deployment = options.deployment ?? workflowRun({
    id: 700,
    path: DEPLOYMENT_PATH,
    displayTitle: "Deploy permanent staging",
    createdAt: "2026-08-14T01:15:00.000Z",
  });
  deployment.updated_at = "2026-08-14T01:50:00.000Z";
  const firstDeployment = workflowRun({
    id: 640,
    path: DEPLOYMENT_PATH,
    displayTitle: "Deploy permanent staging",
    createdAt: "2026-08-14T00:35:00.000Z",
  });
  const deploymentRuns = options.deploymentRuns ??
    (cutover ? [firstDeployment, deployment] : []);
  const deploymentRunId = options.deploymentRunId ?? "700";
  const selectedDeployment = deploymentRuns.find((run) =>
    String(run.id) === deploymentRunId) ?? deployment;
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes(`/commits/${CANDIDATE}/pulls?`)) {
      return response([{
        number: 24,
        state: "closed",
        merge_commit_sha: CANDIDATE,
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: { repo: { full_name: REPOSITORY } },
      }]);
    }
    if (url.endsWith("/pulls/24")) {
      return response({
        number: 24,
        state: "closed",
        merged: true,
        draft: false,
        merge_commit_sha: CANDIDATE,
        merged_at: options.mergedAt ?? "2026-08-14T00:30:00.000Z",
        user: { id: 101 },
        merged_by: { id: 202 },
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: { sha: REVIEWED_HEAD, repo: { full_name: REPOSITORY } },
      });
    }
    if (url.includes("/pulls/24/reviews?")) {
      return response([{
        id: 303,
        user: { id: 303, login: "trusted-reviewer" },
        state: "APPROVED",
        commit_id: REVIEWED_HEAD,
        submitted_at: "2026-08-14T00:20:00.000Z",
        author_association: "MEMBER",
      }]);
    }
    if (url.endsWith("/collaborators/trusted-reviewer/permission")) {
      return response({
        permission: "write",
        user: { id: 303, login: "trusted-reviewer" },
      });
    }
    if (url.endsWith(`/git/commits/${CANDIDATE}`)) {
      return response({
        sha: CANDIDATE,
        tree: { sha: TREE },
        parents: [{ sha: "d".repeat(40) }],
      });
    }
    if (url.endsWith(`/git/commits/${REVIEWED_HEAD}`)) {
      return response({
        sha: REVIEWED_HEAD,
        tree: { sha: TREE },
        parents: [{ sha: "e".repeat(40) }],
      });
    }
    if (url.endsWith(`/actions/runs/${currentId}`)) return response(current);
    if (url.endsWith(`/actions/runs/${deploymentRunId}`)) {
      return response(selectedDeployment);
    }
    if (url.includes("/actions/workflows/permanent-staging-provider-mutation.yml/runs?")) {
      return response({
        total_count: providerRuns.length,
        workflow_runs: providerRuns,
      });
    }
    if (url.includes("/actions/workflows/permanent-staging-supabase-legacy-cutover.yml/runs?")) {
      return response({
        total_count: cutoverRuns.length,
        workflow_runs: cutoverRuns,
      });
    }
    if (url.includes("/actions/workflows/configure-runtime-variable.yml/runs?")) {
      return response({
        total_count: runtimeRuns.length,
        workflow_runs: runtimeRuns,
      });
    }
    if (url.includes("/actions/workflows/deploy-permanent-staging.yml/runs?")) {
      return response({
        total_count: deploymentRuns.length,
        workflow_runs: deploymentRuns,
      });
    }
    const jobsMatch = /\/actions\/runs\/(\d+)\/jobs\?/.exec(url);
    if (jobsMatch) {
      return response(options.jobEvidence?.[Number(jobsMatch[1])] ?? {
        total_count: 0,
        jobs: [],
      });
    }
    return response({ message: "Not found" }, 404);
  }) as unknown as typeof fetch;
  return {
    current,
    fetchImpl,
    verify: () => verifyGithubReviewedCandidateAuthority({
      candidateSha: CANDIDATE,
      operation,
      replacementRunId: cutover
        ? options.replacementRunId ?? "500"
        : null,
      deploymentRunId: cutover ? deploymentRunId : null,
      target: runtime ? target : null,
      variableName: runtime ? variableName : null,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: String(currentId),
        GITHUB_TOKEN: "github-token-long-enough", // security-scan allow: synthetic no-call fixture
      },
      fetchImpl,
    }),
  };
}

describe("reviewed candidate mutation authority", () => {
  it("binds a fresh provider operation while ignoring four distinct prior operations", async () => {
    const current = workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    const otherOperations = PROVIDER_OPERATIONS.slice(0, 4).map(
      (operation, index) => workflowRun({
        id: 400 + index,
        path: PROVIDER_PATH,
        displayTitle: title(operation),
        createdAt: `2026-08-14T01:0${index}:00.000Z`,
      }),
    );
    await expect(harness({
      providerRuns: [...otherOperations, current],
    }).verify()).resolves.toMatchObject({
      operation: "supabase-key-replacement",
      workflowRunId: "500",
      safePriorSkippedWriteRunIds: [],
      reviewedAuthorityExact: true,
      freshDispatchWriteGuardExact: true,
    });
  });

  it("allows only a prior same-operation run proven skipped before the write", async () => {
    const prior = workflowRun({
      id: 450,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      status: "completed",
      conclusion: "failure",
      createdAt: "2026-08-14T01:00:00.000Z",
    });
    const current = workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    await expect(harness({
      providerRuns: [current, prior],
      jobEvidence: { 450: jobs(prior, "skipped") },
    }).verify()).resolves.toMatchObject({
      safePriorSkippedWriteRunIds: ["450"],
    });
    for (const evidence of [jobs(prior, "failure"), { total_count: 0, jobs: [] }]) {
      await expect(harness({
        providerRuns: [current, prior],
        jobEvidence: { 450: evidence },
      }).verify()).rejects.toThrow(
        "github_reviewed_candidate_authority_prior_write_ambiguous",
      );
    }
  });

  it("binds cutover to one selected replacement and rejects prior replacement writes", async () => {
    const selected = workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      createdAt: "2026-08-14T00:45:00.000Z",
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      providerRuns: [selected],
    }).verify()).resolves.toMatchObject({
      operation: "supabase-legacy-key-cutover",
      selectedReplacementRunId: "500",
      safeSkippedReplacementRunIds: [],
      stagingDeploymentRunIds: ["640", "700"],
      closeoutDeploymentRunId: "700",
      stagingDeploymentSequenceExact: true,
    });

    const earlier = workflowRun({
      id: 450,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      createdAt: "2026-08-14T00:40:00.000Z",
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      providerRuns: [selected, earlier],
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_replacement_history_invalid",
    );
  });

  it("requires cutover to select the second of exactly two successful deployments", async () => {
    const first = workflowRun({
      id: 640,
      path: DEPLOYMENT_PATH,
      displayTitle: "Deploy permanent staging",
      createdAt: "2026-08-14T00:35:00.000Z",
    });
    const second = workflowRun({
      id: 700,
      path: DEPLOYMENT_PATH,
      displayTitle: "Deploy permanent staging",
      createdAt: "2026-08-14T01:15:00.000Z",
    });
    second.updated_at = "2026-08-14T01:50:00.000Z";
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      deployment: second,
      deploymentRuns: [second],
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cutover_deployment_sequence_invalid",
    );
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      deploymentRunId: "640",
      deploymentRuns: [first, second],
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cutover_deployment_sequence_invalid",
    );
  });

  it("rejects a repeated cutover unless its write step was definitely skipped", async () => {
    const current = workflowRun({
      id: 600,
      path: CUTOVER_PATH,
      displayTitle: `Permanent staging Supabase legacy cutover | ${CANDIDATE}`,
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    const prior = workflowRun({
      id: 550,
      path: CUTOVER_PATH,
      displayTitle: `Permanent staging Supabase legacy cutover | ${CANDIDATE}`,
      status: "completed",
      conclusion: "failure",
      createdAt: "2026-08-14T01:30:00.000Z",
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      cutoverRuns: [current, prior],
      jobEvidence: { 550: jobs(prior, "skipped") },
    }).verify()).resolves.toMatchObject({ safePriorSkippedWriteRunIds: ["550"] });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      cutoverRuns: [current, prior],
      jobEvidence: { 550: jobs(prior, "failure") },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_prior_write_ambiguous",
    );
  });

  it("authenticates a runtime-variable caller and binds target plus variable", async () => {
    await expect(harness({
      operation: "runtime-variable",
      target: "permanent-staging",
      variableName: "SUPABASE_URL",
    }).verify()).resolves.toMatchObject({
      operation: "runtime-variable",
      workflowPath: RUNTIME_PATH,
      workflowRunId: "650",
      safePriorSkippedWriteRunIds: [],
      reviewedAuthorityExact: true,
    });
  });

  it("allows writes after deploy one and seals staging after deploy two", async () => {
    const first = workflowRun({
      id: 300,
      path: DEPLOYMENT_PATH,
      displayTitle: "Deploy Pint Path permanent staging",
      createdAt: "2026-08-14T00:40:00.000Z",
    });
    const second = workflowRun({
      id: 350,
      path: DEPLOYMENT_PATH,
      displayTitle: "Deploy Pint Path permanent staging",
      createdAt: "2026-08-14T01:20:00.000Z",
    });
    second.updated_at = "2026-08-14T01:30:00.000Z";

    await expect(harness({ deploymentRuns: [first] }).verify()).resolves.toMatchObject({
      successfulStagingDeploymentRunIds: ["300"],
      stagingLifecycleSealed: false,
    });
    for (const fixture of [
      harness({ deploymentRuns: [first, second] }),
      harness({
        current: {
          created_at: "2026-08-14T00:50:00.000Z",
          run_started_at: "2026-08-14T02:00:00.000Z",
        },
        deploymentRuns: [first, second],
      }),
      harness({
        operation: "runtime-variable",
        target: "permanent-staging",
        variableName: "SUPABASE_URL",
        deploymentRuns: [first, second],
      }),
    ]) {
      await expect(fixture.verify()).rejects.toThrow(
        "github_reviewed_candidate_authority_staging_lifecycle_sealed",
      );
    }
    await expect(harness({
      operation: "runtime-variable",
      target: "production",
      variableName: "SUPABASE_URL",
      deploymentRuns: [first, second],
    }).verify()).resolves.toMatchObject({ operation: "runtime-variable" });
  });

  it("rejects every candidate-bound staging write after the selected deployment", async () => {
    const selected = workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      createdAt: "2026-08-14T00:45:00.000Z",
    });
    const lateProvider = workflowRun({
      id: 501,
      path: PROVIDER_PATH,
      displayTitle: title("provider-openai-api-key"),
      createdAt: "2026-08-14T01:16:00.000Z",
    });
    lateProvider.updated_at = "2026-08-14T01:20:00.000Z";
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      providerRuns: [selected, lateProvider],
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_stale_deployment",
    );

    const lateRuntime = workflowRun({
      id: 701,
      path: RUNTIME_PATH,
      displayTitle:
        `Configure runtime variable | permanent-staging | SUPABASE_URL | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:51:00.000Z",
    });
    lateRuntime.updated_at = "2026-08-14T01:55:00.000Z";
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      providerRuns: [selected],
      runtimeRuns: [lateRuntime],
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_stale_deployment",
    );

    const unrelatedProduction = workflowRun({
      id: 702,
      path: RUNTIME_PATH,
      displayTitle:
        `Configure runtime variable | production | SUPABASE_URL | ${CANDIDATE}`,
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T01:51:00.000Z",
      runAttempt: 2,
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      providerRuns: [selected],
      runtimeRuns: [unrelatedProduction],
    }).verify()).resolves.toMatchObject({
      noPostDeploymentStagingWritesExact: true,
    });
  });

  it("uses run start for the exact seven-day retained-history boundary", async () => {
    const exactBoundary = harness({
      current: {
        created_at: "2026-08-14T00:31:00.000Z",
        run_started_at: "2026-08-21T00:30:00.000Z",
      },
    });
    await expect(exactBoundary.verify()).resolves.toMatchObject({
      candidateHistoryMaximumAgeHours: 168,
    });
    expect(exactBoundary.fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(
        "2026-08-14T00:30:00.000Z..2026-08-21T00:30:00.000Z",
      )),
      expect.anything(),
    );
    await expect(harness({
      current: {
        created_at: "2026-08-14T00:31:00.000Z",
        run_started_at: "2026-08-21T00:30:00.001Z",
      },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_candidate_history_expired",
    );
  });

  it("rejects a misbound current workflow before trusting history", async () => {
    await expect(harness({
      current: { path: `${CUTOVER_PATH}@main` },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_current_run_invalid",
    );
  });
});
