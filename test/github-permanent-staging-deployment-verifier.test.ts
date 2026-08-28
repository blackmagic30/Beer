import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { verifyGithubPermanentStagingDeployment } from
  "../scripts/verify-github-permanent-staging-deployment.mjs";

const CANDIDATE = "a".repeat(40);
const REPLACEMENT_RUN_ID = "100";
const FENCED_DEPLOYMENT_RUN_ID = "180";
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
  name: string;
  display_title: string;
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
  const name = path === DEPLOYMENT_WORKFLOW
    ? "Deploy Pint Path permanent staging"
    : path === REPLACEMENT_WORKFLOW
    ? "Mutate Pint Path permanent-staging provider variables"
    : "Permanent staging Supabase legacy-key cutover";
  const displayTitle = path === DEPLOYMENT_WORKFLOW
    ? `Deploy permanent staging | active | ${CANDIDATE}`
    : path === REPLACEMENT_WORKFLOW
    ? `Permanent staging provider mutation | supabase-key-replacement | ${CANDIDATE}`
    : `Permanent staging Supabase legacy cutover | disable-enabled-legacy-keys | ${CANDIDATE}`;
  return {
    id,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    head_sha: CANDIDATE,
    head_branch: "main",
    path: `${path}@main`,
    name,
    display_title: displayTitle,
    event: "workflow_dispatch",
    run_attempt: 1,
    status,
    conclusion,
    created_at: startedAt,
    run_started_at: startedAt,
    updated_at: updatedAt,
  };
}

function deploymentRun(
  id: number,
  phase: "fenced" | "active",
  status: string,
  conclusion: string | null,
  startedAt: string,
  updatedAt: string,
): WorkflowRun {
  return {
    ...run(id, DEPLOYMENT_WORKFLOW, status, conclusion, startedAt, updatedAt),
    display_title: `Deploy permanent staging | ${phase} | ${CANDIDATE}`,
  };
}

const CHECK_KEYS = [
  "boundaryPostflightExact",
  "boundaryPreflightExact",
  "cliExact",
  "collateralInventoryExact",
  "collateralStateUnchanged",
  "costPolicyExact",
  "deploymentExact",
  "durableIntentExact",
  "gitAutodeployAbsent",
  "githubMainExact",
  "policyExact",
  "prerequisiteExact",
  "reconciliationCompleted",
  "runtimeHealthExact",
  "runtimeReadinessExact",
  "runtimeStartupExact",
  "sourceAuthorityExact",
  "sourceReasserted",
  "targetPostflightAttempted",
  "targetPostflightExact",
  "targetPreflightExact",
  "terminalEvidenceExact",
  "topologyPreserved",
  "workerFenceDeploymentContinuityExact",
  "workerFencePrerequisiteExact",
  "writeAttemptedAtMostOnce",
  "writeTokenScopeExact",
] as const;

function deploymentReceipt(
  phase: "fenced" | "active",
  outcome: "deployed" | "reconciled_success" | "already_deployed" =
    phase === "active" ? "already_deployed" : "deployed",
) {
  const readOnly = outcome === "already_deployed";
  const runtime = phase === "fenced"
    ? { health: null, startup: null, ready: null }
    : { health: "1".repeat(64), startup: "2".repeat(64), ready: "3".repeat(64) };
  return {
    schemaVersion: "pintpath-railway-application-deployment-executor/v5",
    operation: "pintpath-railway-application-source-upload",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    target: "permanent-staging",
    outcome,
    failureCode: null,
    candidateSha: CANDIDATE,
    startedAt: phase === "fenced"
      ? "2026-08-14T01:01:01.000Z"
      : "2026-08-14T02:01:01.000Z",
    completedAt: phase === "fenced"
      ? "2026-08-14T01:29:59.000Z"
      : "2026-08-14T02:29:59.000Z",
    writeAttempts: readOnly ? 0 : 1,
    acknowledgement: readOnly
      ? "not_attempted"
      : outcome === "deployed" ? "received" : "missing_or_failed",
    previousDeploymentIdSha256: readOnly ? "5".repeat(64) : "4".repeat(64),
    deploymentIdSha256: "5".repeat(64),
    intentSha256: "6".repeat(64),
    cliOutputSha256: readOnly ? null : "7".repeat(64),
    boundaryPreflightSha256: "8".repeat(64),
    boundaryPostflightSha256: "9".repeat(64),
    collateralSnapshotSha256s: {
      before: "b".repeat(64),
      after: "b".repeat(64),
    },
    replicaCounts: phase === "fenced"
      ? { before: 0, after: 0 }
      : { before: 1, after: 1 },
    runtimeResponseSha256s: runtime,
    workerFencePrerequisite: null,
    checks: Object.fromEntries(CHECK_KEYS.map((key) => [key, true])),
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

function failedBeforeWriteJobs(
  runId: number,
  mutationConclusion = "skipped",
  jobConclusion = "failure",
) {
  return {
    total_count: 1,
    jobs: [{
      run_id: runId,
      run_attempt: 1,
      name: "Deploy permanent staging",
      status: "completed",
      conclusion: jobConclusion,
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
  fencedDeployment?: Partial<WorkflowRun>;
  deployment?: Partial<WorkflowRun>;
  replacementListing?: unknown;
  deploymentListing?: unknown;
  replacementRuns?: WorkflowRun[];
  deploymentRuns?: WorkflowRun[];
  fencedDeploymentListing?: unknown;
  fencedDeploymentReceipt?: unknown;
  deploymentReceipt?: unknown;
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
    ...deploymentRun(
      Number(DEPLOYMENT_RUN_ID),
      "active",
      "completed",
      "success",
      "2026-08-14T02:01:00.000Z",
      "2026-08-14T02:30:00.000Z",
    ),
    ...options.deployment,
  };
  const fencedDeployment = {
    ...deploymentRun(
      Number(FENCED_DEPLOYMENT_RUN_ID),
      "fenced",
      "completed",
      "success",
      "2026-08-14T01:01:00.000Z",
      "2026-08-14T01:30:00.000Z",
    ),
    ...options.fencedDeployment,
  };
  const replacementName =
    `pintpath-permanent-staging-provider-mutation-supabase-key-replacement-${CANDIDATE}`;
  const deploymentName = `pintpath-permanent-staging-deployment-${CANDIDATE}`;
  const fencedDeploymentName =
    `pintpath-permanent-staging-fenced-deployment-${CANDIDATE}`;
  const replacementListing = options.replacementListing ?? {
    total_count: 1,
    artifacts: [artifact(replacementName, Number(REPLACEMENT_RUN_ID))],
  };
  const deploymentListing = options.deploymentListing ?? {
    total_count: 1,
    artifacts: [artifact(deploymentName, Number(DEPLOYMENT_RUN_ID))],
  };
  const fencedDeploymentListing = options.fencedDeploymentListing ?? {
    total_count: 1,
    artifacts: [artifact(
      fencedDeploymentName,
      Number(FENCED_DEPLOYMENT_RUN_ID),
    )],
  };
  const deploymentRuns = options.deploymentRuns ?? [fencedDeployment, deployment];
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
    if (url.endsWith(`/actions/runs/${FENCED_DEPLOYMENT_RUN_ID}`)) {
      return json(fencedDeployment);
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
    if (
      url ===
      `https://api.github.com/repos/${REPOSITORY}/actions/runs/${FENCED_DEPLOYMENT_RUN_ID}/artifacts?name=${encodeURIComponent(fencedDeploymentName)}&per_page=100`
    ) {
      return json(fencedDeploymentListing);
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
      fencedDeploymentRunId: FENCED_DEPLOYMENT_RUN_ID,
      deploymentRunId: DEPLOYMENT_RUN_ID,
      fencedDeploymentReceipt:
        options.fencedDeploymentReceipt ?? deploymentReceipt("fenced"),
      deploymentReceipt:
        options.deploymentReceipt ?? deploymentReceipt("active"),
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
      schemaVersion: 2,
      kind: "pintpath-github-permanent-staging-deployment-authority",
      repository: REPOSITORY,
      candidateSha: CANDIDATE,
      consumerWorkflowRunId: CUTOVER_RUN_ID,
      replacementWorkflowRunId: REPLACEMENT_RUN_ID,
      replacementWorkflowConclusion: "success",
      replacementWorkflowRunCreatedAt: "2026-08-14T00:00:00.000Z",
      fencedDeploymentWorkflowRunId: FENCED_DEPLOYMENT_RUN_ID,
      fencedDeploymentReceiptOutcome: "deployed",
      deploymentWorkflowRunId: DEPLOYMENT_RUN_ID,
      deploymentWorkflowConclusion: "success",
      deploymentReceiptOutcome: "already_deployed",
      replacementPrecedesDeployment: true,
      fencedDeploymentPrecedesActiveDeployment: true,
      deploymentPrecedesCutover: true,
    }));
    expect(authority.replacementArtifactName).toBe(
      `pintpath-permanent-staging-provider-mutation-supabase-key-replacement-${CANDIDATE}`,
    );
    expect(authority.deploymentArtifactName).toBe(
      `pintpath-permanent-staging-deployment-${CANDIDATE}`,
    );
    expect(authority.fencedDeploymentArtifactName).toBe(
      `pintpath-permanent-staging-fenced-deployment-${CANDIDATE}`,
    );
    expect(authority).toMatchObject({
      deploymentWindowExact: true,
      failedBeforeWriteDeploymentRunIds: [],
      replacementWindowExact: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(9);
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
    [
      "fenced deployment title",
      { fencedDeployment: { display_title: `Deploy permanent staging | active | ${CANDIDATE}` } },
    ],
    ["cutover workflow", { current: { path: DEPLOYMENT_WORKFLOW } }],
    ["cutover attempt", { current: { run_attempt: 2 } }],
  ])("rejects a substituted %s", async (_label, options) => {
    await expect(harness(options).verify()).rejects.toThrow(
      /github_permanent_staging_deployment_(?:replacement|fenced_deployment|deployment|consumer)_run_invalid/,
    );
  });

  it("requires exact, unique, unexpired artifacts from all authenticated runs", async () => {
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

    await expect(harness({
      fencedDeploymentListing: { total_count: 0, artifacts: [] },
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
        "2026-08-14T00:00:00.000Z..2026-08-14T02:01:00.000Z",
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

  it("allows an approved retry after an authenticated failure before the write step", async () => {
    const fenced = deploymentRun(
      Number(FENCED_DEPLOYMENT_RUN_ID),
      "fenced",
      "completed",
      "success",
      "2026-08-14T01:01:00.000Z",
      "2026-08-14T01:30:00.000Z",
    );
    const failed = deploymentRun(
      150,
      "active",
      "completed",
      "failure",
      "2026-08-14T01:40:20.000Z",
      "2026-08-14T01:40:40.000Z",
    );
    const fixture = harness({
      deploymentRuns: [fenced, failed, deploymentRun(
        Number(DEPLOYMENT_RUN_ID),
        "active",
        "completed",
        "success",
        "2026-08-14T02:01:00.000Z",
        "2026-08-14T02:30:00.000Z",
      )],
      failedRunJobs: { "150": failedBeforeWriteJobs(150) },
    });
    await expect(fixture.verify()).resolves.toMatchObject({
      deploymentWindowExact: true,
      failedBeforeWriteDeploymentRunIds: ["150"],
    });

  });

  it("reconciles one ambiguous phase only through an exact already-candidate receipt", async () => {
    const failedFenced = deploymentRun(
      150,
      "fenced",
      "completed",
      "failure",
      "2026-08-14T01:00:10.000Z",
      "2026-08-14T01:00:40.000Z",
    );
    const fenced = deploymentRun(
      Number(FENCED_DEPLOYMENT_RUN_ID),
      "fenced",
      "completed",
      "success",
      "2026-08-14T01:01:00.000Z",
      "2026-08-14T01:30:00.000Z",
    );
    const active = deploymentRun(
      Number(DEPLOYMENT_RUN_ID),
      "active",
      "completed",
      "success",
      "2026-08-14T02:01:00.000Z",
      "2026-08-14T02:30:00.000Z",
    );
    await expect(harness({
      deploymentRuns: [failedFenced, fenced, active],
      failedRunJobs: { "150": failedBeforeWriteJobs(150, "failure") },
      fencedDeploymentReceipt: deploymentReceipt("fenced", "already_deployed"),
    }).verify()).resolves.toMatchObject({
      fencedDeploymentReceiptOutcome: "already_deployed",
      reconciledAmbiguousFencedDeploymentRunIds: ["150"],
    });

    const failedActive = deploymentRun(
      190,
      "active",
      "completed",
      "failure",
      "2026-08-14T01:40:00.000Z",
      "2026-08-14T01:50:00.000Z",
    );
    await expect(harness({
      deploymentRuns: [fenced, failedActive, active],
      failedRunJobs: { "190": failedBeforeWriteJobs(190, "failure") },
    }).verify()).resolves.toMatchObject({
      deploymentReceiptOutcome: "already_deployed",
      reconciledAmbiguousActiveDeploymentRunIds: ["190"],
    });

    await expect(harness({
      deploymentRuns: [failedFenced, fenced, active],
      failedRunJobs: { "150": failedBeforeWriteJobs(150, "failure") },
    }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_deployment_window_invalid",
    );

    await expect(harness({
      deploymentReceipt: deploymentReceipt("active", "deployed"),
    }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_receipt_invalid",
    );

    const lateAmbiguousFenced = deploymentRun(
      151,
      "fenced",
      "completed",
      "failure",
      "2026-08-14T01:31:00.000Z",
      "2026-08-14T01:40:00.000Z",
    );
    await expect(harness({
      deploymentRuns: [fenced, lateAmbiguousFenced, active],
      failedRunJobs: { "151": failedBeforeWriteJobs(151, "failure") },
      fencedDeploymentReceipt: deploymentReceipt("fenced", "already_deployed"),
    }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_deployment_window_invalid",
    );
  });

  it("rejects every deployment dispatch after the selected active closeout", async () => {
    const fenced = deploymentRun(
      Number(FENCED_DEPLOYMENT_RUN_ID),
      "fenced",
      "completed",
      "success",
      "2026-08-14T01:01:00.000Z",
      "2026-08-14T01:30:00.000Z",
    );
    const active = deploymentRun(
      Number(DEPLOYMENT_RUN_ID),
      "active",
      "completed",
      "success",
      "2026-08-14T02:01:00.000Z",
      "2026-08-14T02:30:00.000Z",
    );
    const postCloseout = deploymentRun(
      250,
      "active",
      "completed",
      "failure",
      "2026-08-14T02:31:00.000Z",
      "2026-08-14T02:40:00.000Z",
    );
    await expect(harness({
      deploymentRuns: [fenced, active, postCloseout],
      failedRunJobs: { "250": failedBeforeWriteJobs(250) },
    }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_deployment_window_invalid",
    );
  });

  it("rejects an older, wrong, or intervened deployment selection", async () => {
    const fenced = deploymentRun(
      Number(FENCED_DEPLOYMENT_RUN_ID),
      "fenced",
      "completed",
      "success",
      "2026-08-14T01:01:00.000Z",
      "2026-08-14T01:30:00.000Z",
    );
    const active = deploymentRun(
      Number(DEPLOYMENT_RUN_ID),
      "active",
      "completed",
      "success",
      "2026-08-14T02:01:00.000Z",
      "2026-08-14T02:30:00.000Z",
    );
    const wrong = deploymentRun(
      199,
      "active",
      "completed",
      "success",
      "2026-08-14T02:01:00.000Z",
      "2026-08-14T02:20:00.000Z",
    );
    await expect(harness({ deploymentRuns: [fenced, wrong] }).verify()).rejects.toThrow(
      "github_permanent_staging_deployment_deployment_window_invalid",
    );

    const intervening = deploymentRun(
      250,
      "active",
      "completed",
      "success",
      "2026-08-14T02:31:00.000Z",
      "2026-08-14T02:40:00.000Z",
    );
    await expect(harness({
      deploymentRuns: [fenced, active, intervening],
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
