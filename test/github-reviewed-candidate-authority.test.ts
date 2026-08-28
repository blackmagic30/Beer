import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  runGithubReviewedCandidateAuthority,
  verifyGithubReviewedCandidateAuthority,
} from "../scripts/verify-github-reviewed-candidate-authority.mjs";

const CANDIDATE = "a".repeat(40);
const REVIEWED_HEAD = "b".repeat(40);
const TREE = "c".repeat(40);
const REPOSITORY = "blackmagic30/Beer";
const PROVIDER_PATH =
  ".github/workflows/permanent-staging-provider-mutation.yml";
const CUTOVER_PATH =
  ".github/workflows/permanent-staging-supabase-legacy-cutover.yml";
const RUNTIME_PATH = ".github/workflows/configure-runtime-variable.yml";
const COLD_RECOVERY_PATH =
  ".github/workflows/recover-permanent-staging-cold-zero.yml";
const STAGING_BOOTSTRAP_PATH =
  ".github/workflows/bootstrap-permanent-staging-worker-fence.yml";
const WORKER_FENCE_PATH =
  ".github/workflows/configure-automatic-maintenance-worker-fence.yml";
const DEPLOYMENT_PATH = ".github/workflows/deploy-permanent-staging.yml";
const PROVIDER_OPERATIONS = [
  "provider-google-maps-api-key",
  "provider-google-maps-map-id",
  "provider-google-places-api-key",
  "provider-openai-api-key",
  "supabase-key-replacement",
  "remove-forbidden-offsite-backup-variables",
  "resume-forbidden-offsite-backup-deletion-patch",
  "cancel-forbidden-offsite-backup-deletion-patch",
] as const;
const DISABLE_CUTOVER_MODE = "disable-enabled-legacy-keys";
const RECONCILE_CUTOVER_MODE = "reconcile-already-disabled-legacy-keys";

function cutoverTitle(mode: string) {
  return `Permanent staging Supabase legacy cutover | ${mode} | ${CANDIDATE}`;
}

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
  updatedAt?: string;
  runAttempt?: number;
}) {
  const createdAt = input.createdAt ?? "2026-08-14T01:00:00.000Z";
  const updatedAt = input.updatedAt ?? new Date(
    Date.parse(createdAt) + 10 * 60 * 1000,
  ).toISOString();
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
    updated_at: updatedAt,
  };
}

function jobs(run: Run, stepConclusion: string) {
  const cutover = run.path.startsWith(CUTOVER_PATH);
  const coldPrepare = run.path.startsWith(COLD_RECOVERY_PATH) &&
    run.display_title ===
      `Permanent staging cold recovery | prepare | ${CANDIDATE}`;
  const coldPrepareReconcile = run.path.startsWith(COLD_RECOVERY_PATH) &&
    run.display_title ===
      `Permanent staging cold recovery | reconcile-prepare | ${CANDIDATE}`;
  const coldQuiesce = run.path.startsWith(COLD_RECOVERY_PATH) &&
    run.display_title ===
      `Permanent staging cold recovery | quiesce | ${CANDIDATE}`;
  const coldReconcile = run.path.startsWith(COLD_RECOVERY_PATH) &&
    run.display_title ===
      `Permanent staging cold recovery | reconcile-quiesce | ${CANDIDATE}`;
  if (coldPrepare || coldPrepareReconcile || coldQuiesce || coldReconcile) {
    const selectedName = coldPrepare
      ? "Bind the exact replacement and prepare the dead baseline"
      : coldPrepareReconcile
      ? "Reconcile an ambiguous cold prepare at the exact dead baseline"
      : coldQuiesce
      ? "Initialize the exact dead baseline at explicit zero"
      : "Reconcile an ambiguous cold quiesce at exact zero";
    const selectedStep = coldPrepare
      ? "Prepare the exact dead staging baseline once"
      : coldPrepareReconcile
      ? "Prove the ambiguous cold prepare reached the exact dead baseline without a second write"
      : coldQuiesce
      ? "Initialize the dead baseline from null to explicit zero once"
      : "Prove the ambiguous cold quiesce reached exact zero without a second write";
    const names = [
      "Bind the exact replacement and prepare the dead baseline",
      "Reconcile an ambiguous cold prepare at the exact dead baseline",
      "Initialize the exact dead baseline at explicit zero",
      "Reconcile an ambiguous cold quiesce at exact zero",
    ];
    return {
      total_count: 4,
      jobs: names.map((name) => name === selectedName
        ? {
            run_id: run.id,
            run_attempt: 1,
            name,
            status: "completed",
            conclusion: run.conclusion,
            steps: [{
              name: selectedStep,
              status: "completed",
              conclusion: stepConclusion,
            }],
          }
        : {
            run_id: run.id,
            run_attempt: 1,
            name,
            status: "completed",
            conclusion: "skipped",
            steps: [],
      }),
    };
  }
  const bootstrapRestore = run.path.startsWith(STAGING_BOOTSTRAP_PATH) &&
    run.display_title ===
      `Permanent staging worker bootstrap | restore | ${CANDIDATE}`;
  const bootstrapReconcile = run.path.startsWith(STAGING_BOOTSTRAP_PATH) &&
    run.display_title ===
      `Permanent staging worker bootstrap | reconcile-restore | ${CANDIDATE}`;
  if (bootstrapRestore || bootstrapReconcile) {
    const selectedName = bootstrapRestore
      ? "Verify the chain and perform one exact protected scale transition"
      : "Reconcile an ambiguous staging bootstrap restore at exact one";
    const names = [
      "Verify the chain and perform one exact protected scale transition",
      "Reconcile an ambiguous staging bootstrap restore at exact one",
    ];
    return {
      total_count: 2,
      jobs: names.map((name) => name === selectedName
        ? {
            run_id: run.id,
            run_attempt: 1,
            name,
            status: "completed",
            conclusion: run.conclusion,
            steps: [{
              name: bootstrapRestore
                ? "Perform at most one exact candidate-bound scale transition"
                : "Prove exact candidate one without a second scale transition",
              status: "completed",
              conclusion: stepConclusion,
            }],
          }
        : {
            run_id: run.id,
            run_attempt: 1,
            name,
            status: "completed",
            conclusion: "skipped",
            steps: [],
          }),
    };
  }
  const workerActivate = run.path.startsWith(WORKER_FENCE_PATH) &&
    run.display_title ===
      `Automatic maintenance worker fence | permanent-staging | activate | ${CANDIDATE}`;
  const workerReconcile = run.path.startsWith(WORKER_FENCE_PATH) &&
    run.display_title ===
      `Automatic maintenance worker fence | permanent-staging | reconcile-activate | ${CANDIDATE}`;
  if (workerActivate || workerReconcile) {
    const selectedName = workerActivate
      ? "One candidate-bound automatic-maintenance transition"
      : "Reconcile an ambiguous staging automatic-maintenance activation";
    const names = [
      "One candidate-bound automatic-maintenance transition",
      "Reconcile an ambiguous staging automatic-maintenance activation",
    ];
    return {
      total_count: 2,
      jobs: names.map((name) => name === selectedName
        ? {
            run_id: run.id,
            run_attempt: 1,
            name,
            status: "completed",
            conclusion: run.conclusion,
            steps: [{
              name: workerActivate
                ? "Execute at most one exact atomic Railway variable upsert"
                : "Prove exact activated state without a second variable upsert",
              status: "completed",
              conclusion: stepConclusion,
            }],
          }
        : {
            run_id: run.id,
            run_attempt: 1,
            name,
            status: "completed",
            conclusion: "skipped",
            steps: [],
          }),
    };
  }
  return {
    total_count: 1,
    jobs: [{
      run_id: run.id,
      run_attempt: 1,
      name: cutover
        ? "Reconcile or disable exact permanent-staging legacy keys"
        : "One protected variable mutation plan",
      status: "completed",
      conclusion: run.conclusion,
      steps: [{
        name: cutover
          ? "Canary replacement keys and reconcile or disable legacy keys once"
          : "Execute one reviewed protected Railway mutation plan",
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
  coldRecoveryRuns?: Run[];
  bootstrapRuns?: Run[];
  workerRuns?: Run[];
  deploymentRuns?: Run[];
  jobEvidence?: Record<number, unknown>;
  mergedAt?: string;
  replacementRunId?: string | null;
  deployment?: Run;
  deploymentRunId?: string;
  cutoverMode?: string;
  priorRunId?: string | null;
  prepareRunId?: string | null;
  target?: string;
  variableName?: string;
} = {}) {
  const operation = options.operation ?? "supabase-key-replacement";
  const cutover = operation === "supabase-legacy-key-cutover";
  const cutoverMode = options.cutoverMode ?? DISABLE_CUTOVER_MODE;
  const runtime = operation === "runtime-variable";
  const coldPrepare = operation === "cold-recovery-prepare";
  const coldPrepareReconcile =
    operation === "cold-recovery-reconcile-prepare";
  const coldQuiesce = operation === "cold-recovery-quiesce";
  const coldReconcile = operation === "cold-recovery-reconcile-quiesce";
  const restoreReconcile =
    operation === "staging-worker-bootstrap-reconcile-restore";
  const activateReconcile =
    operation === "staging-worker-fence-reconcile-activate";
  const coldRecovery = coldPrepare || coldPrepareReconcile || coldQuiesce ||
    coldReconcile;
  const currentId = cutover
    ? 600
    : runtime
    ? 650
    : coldPrepare
    ? 675
    : coldPrepareReconcile
    ? 674
    : coldQuiesce
    ? 676
    : coldReconcile
    ? 677
    : restoreReconcile
    ? 680
    : activateReconcile
    ? 690
    : 500;
  const target = options.target ?? "permanent-staging";
  const variableName = options.variableName ?? "SUPABASE_URL";
  const current = {
    ...workflowRun({
      id: currentId,
      path: cutover
        ? CUTOVER_PATH
        : runtime
        ? RUNTIME_PATH
        : coldRecovery
        ? COLD_RECOVERY_PATH
        : restoreReconcile
        ? STAGING_BOOTSTRAP_PATH
        : activateReconcile
        ? WORKER_FENCE_PATH
        : PROVIDER_PATH,
      displayTitle: cutover
        ? cutoverTitle(cutoverMode)
        : runtime
        ? `Configure runtime variable | ${target} | ${variableName} | ${CANDIDATE}`
        : coldRecovery
        ? `Permanent staging cold recovery | ${coldPrepare
          ? "prepare"
          : coldPrepareReconcile
          ? "reconcile-prepare"
          : coldQuiesce
          ? "quiesce"
          : "reconcile-quiesce"} | ${CANDIDATE}`
        : restoreReconcile
        ? `Permanent staging worker bootstrap | reconcile-restore | ${CANDIDATE}`
        : activateReconcile
        ? `Automatic maintenance worker fence | permanent-staging | reconcile-activate | ${CANDIDATE}`
        : title(operation),
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    }),
    ...options.current,
  };
  const providerRuns = options.providerRuns ??
    (cutover || coldPrepare || coldPrepareReconcile
    ? [workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      createdAt: "2026-08-14T00:45:00.000Z",
    })]
    : runtime || coldRecovery || restoreReconcile || activateReconcile
    ? []
    : [current]);
  const cutoverRuns = options.cutoverRuns ?? (cutover ? [current] : []);
  const runtimeRuns = options.runtimeRuns ?? (runtime ? [current] : []);
  const selectedPrepare = workflowRun({
    id: 675,
    path: COLD_RECOVERY_PATH,
    displayTitle: `Permanent staging cold recovery | prepare | ${CANDIDATE}`,
    createdAt: "2026-08-14T00:45:00.000Z",
  });
  selectedPrepare.updated_at = "2026-08-14T01:00:00.000Z";
  const ambiguousPrepare = workflowRun({
    id: 673,
    path: COLD_RECOVERY_PATH,
    displayTitle: `Permanent staging cold recovery | prepare | ${CANDIDATE}`,
    conclusion: "cancelled",
    createdAt: "2026-08-14T01:10:00.000Z",
  });
  const ambiguousQuiesce = workflowRun({
    id: 676,
    path: COLD_RECOVERY_PATH,
    displayTitle: `Permanent staging cold recovery | quiesce | ${CANDIDATE}`,
    conclusion: "cancelled",
    createdAt: "2026-08-14T01:10:00.000Z",
  });
  const coldRecoveryRuns = options.coldRecoveryRuns ??
    (coldPrepareReconcile
      ? [ambiguousPrepare, current]
      : coldReconcile
      ? [selectedPrepare, ambiguousQuiesce, current]
      : coldRecovery ? [current] : []);
  const selectedQuiesce = workflowRun({
    id: 678,
    path: STAGING_BOOTSTRAP_PATH,
    displayTitle: `Permanent staging worker bootstrap | quiesce | ${CANDIDATE}`,
    createdAt: "2026-08-14T00:45:00.000Z",
  });
  const ambiguousRestore = workflowRun({
    id: 679,
    path: STAGING_BOOTSTRAP_PATH,
    displayTitle: `Permanent staging worker bootstrap | restore | ${CANDIDATE}`,
    conclusion: "cancelled",
    createdAt: "2026-08-14T01:10:00.000Z",
  });
  const bootstrapRuns = options.bootstrapRuns ?? (restoreReconcile
    ? [selectedQuiesce, ambiguousRestore, current]
    : []);
  const selectedWorkerPrepare = workflowRun({
    id: 688,
    path: WORKER_FENCE_PATH,
    displayTitle:
      `Automatic maintenance worker fence | permanent-staging | prepare | ${CANDIDATE}`,
    createdAt: "2026-08-14T00:45:00.000Z",
  });
  const ambiguousActivate = workflowRun({
    id: 689,
    path: WORKER_FENCE_PATH,
    displayTitle:
      `Automatic maintenance worker fence | permanent-staging | activate | ${CANDIDATE}`,
    conclusion: "cancelled",
    createdAt: "2026-08-14T01:10:00.000Z",
  });
  const workerRuns = options.workerRuns ?? (activateReconcile
    ? [selectedWorkerPrepare, ambiguousActivate, current]
    : []);
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
    if (url.includes("/actions/workflows/recover-permanent-staging-cold-zero.yml/runs?")) {
      return response({
        total_count: coldRecoveryRuns.length,
        workflow_runs: coldRecoveryRuns,
      });
    }
    if (url.includes("/actions/workflows/bootstrap-permanent-staging-worker-fence.yml/runs?")) {
      return response({
        total_count: bootstrapRuns.length,
        workflow_runs: bootstrapRuns,
      });
    }
    if (url.includes("/actions/workflows/configure-automatic-maintenance-worker-fence.yml/runs?")) {
      return response({
        total_count: workerRuns.length,
        workflow_runs: workerRuns,
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
      const runId = Number(jobsMatch[1]);
      return response(options.jobEvidence?.[runId] ??
        (coldPrepareReconcile && runId === ambiguousPrepare.id
          ? jobs(ambiguousPrepare, "cancelled")
          : coldReconcile && runId === ambiguousQuiesce.id
          ? jobs(ambiguousQuiesce, "cancelled")
          : restoreReconcile && runId === ambiguousRestore.id
          ? jobs(ambiguousRestore, "cancelled")
          : activateReconcile && runId === ambiguousActivate.id
          ? jobs(ambiguousActivate, "cancelled")
          : {
        total_count: 0,
        jobs: [],
      }));
    }
    return response({ message: "Not found" }, 404);
  }) as unknown as typeof fetch;
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CANDIDATE,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: String(currentId),
    GITHUB_TOKEN: "github-token-long-enough", // security-scan allow: synthetic no-call fixture
  };
  return {
    current,
    env,
    fetchImpl,
    verify: () => verifyGithubReviewedCandidateAuthority({
      candidateSha: CANDIDATE,
      operation,
      replacementRunId: cutover || coldPrepare || coldPrepareReconcile
        ? options.replacementRunId ?? "500"
        : null,
      deploymentRunId: cutover ? deploymentRunId : null,
      cutoverMode: cutover ? cutoverMode : null,
      priorRunId: coldPrepareReconcile
        ? options.priorRunId ?? "673"
        : coldReconcile
        ? options.priorRunId ?? "676"
        : restoreReconcile
        ? options.priorRunId ?? "679"
        : activateReconcile
        ? options.priorRunId ?? "689"
        : options.priorRunId ?? null,
      prepareRunId: coldReconcile ? options.prepareRunId ?? "675" : null,
      target: runtime ? target : null,
      variableName: runtime ? variableName : null,
      env,
      fetchImpl,
    }),
  };
}

describe("reviewed candidate mutation authority", () => {
  it("binds cold history to the exact workflow job names", () => {
    const workflow = fs.readFileSync(COLD_RECOVERY_PATH, "utf8");
    expect(workflow).toContain(
      "name: Bind the exact replacement and prepare the dead baseline",
    );
    expect(workflow).toContain(
      "name: Reconcile an ambiguous cold prepare at the exact dead baseline",
    );
    expect(workflow).toContain(
      "name: Initialize the exact dead baseline at explicit zero",
    );
    expect(workflow).toContain(
      "name: Reconcile an ambiguous cold quiesce at exact zero",
    );
  });

  it("requires a selected replacement run in the cold-prepare CLI contract", async () => {
    const fixture = harness({ operation: "cold-recovery-prepare" });
    let summary = "";
    await expect(runGithubReviewedCandidateAuthority([
      "--candidate-sha",
      CANDIDATE,
      "--operation",
      "cold-recovery-prepare",
      "--replacement-run-id",
      "500",
    ], {
      env: fixture.env,
      fetchImpl: fixture.fetchImpl,
      writeOutput: (value: string) => { summary += value; },
    })).resolves.toBe(0);
    expect(JSON.parse(summary)).toMatchObject({
      ok: true,
      operation: "cold-recovery-prepare",
      selectedReplacementRunId: "500",
    });

    summary = "";
    await expect(runGithubReviewedCandidateAuthority([
      "--candidate-sha",
      CANDIDATE,
      "--operation",
      "cold-recovery-prepare",
    ], {
      env: fixture.env,
      fetchImpl: fixture.fetchImpl,
      writeOutput: (value: string) => { summary += value; },
    })).resolves.toBe(1);
    expect(JSON.parse(summary)).toMatchObject({
      ok: false,
      failureCode: "github_reviewed_candidate_authority_arguments_invalid",
    });
  });

  it.each([
    ["cold-recovery-prepare", "prepare", "675"],
    ["cold-recovery-quiesce", "quiesce", "676"],
    ["cold-recovery-reconcile-quiesce", "reconcile-quiesce", "677"],
  ])(
    "binds %s to the exact cold-recovery workflow dispatch",
    async (operation, coldOperation, workflowRunId) => {
      await expect(harness({ operation }).verify()).resolves.toMatchObject({
        operation,
        workflowPath: COLD_RECOVERY_PATH,
        workflowRunId,
        safePriorSkippedWriteRunIds: [],
        stagingLifecycleSealed: false,
        ...(operation === "cold-recovery-prepare"
          ? { selectedReplacementRunId: "500" }
          : operation === "cold-recovery-reconcile-quiesce"
          ? {
              priorAmbiguousColdQuiesceRunId: "676",
              selectedColdPrepareRunId: "675",
              secondColdScaleWritePreventedExact: true,
            }
          : {}),
        reviewedAuthorityExact: true,
        freshDispatchWriteGuardExact: true,
      });
      expect(coldOperation).toMatch(/^(prepare|quiesce|reconcile-quiesce)$/);
    },
  );

  it("authorizes read-only cold reconciliation for exactly one ambiguous quiesce", async () => {
    const fixture = harness({
      operation: "cold-recovery-reconcile-quiesce",
    });
    let summary = "";
    await expect(runGithubReviewedCandidateAuthority([
      "--candidate-sha", CANDIDATE,
      "--operation", "cold-recovery-reconcile-quiesce",
      "--prior-run-id", "676",
      "--prepare-run-id", "675",
    ], {
      env: fixture.env,
      fetchImpl: fixture.fetchImpl,
      writeOutput: (value: string) => { summary += value; },
    })).resolves.toBe(0);
    expect(JSON.parse(summary)).toMatchObject({
      ok: true,
      operation: "cold-recovery-reconcile-quiesce",
      priorAmbiguousColdQuiesceRunId: "676",
      selectedColdPrepareRunId: "675",
      exactPriorColdQuiesceCandidateRunBound: true,
      secondColdScaleWritePreventedExact: true,
    });

    const prepare = workflowRun({
      id: 675,
      path: COLD_RECOVERY_PATH,
      displayTitle: `Permanent staging cold recovery | prepare | ${CANDIDATE}`,
      createdAt: "2026-08-14T00:45:00.000Z",
    });
    prepare.updated_at = "2026-08-14T01:00:00.000Z";
    const ambiguous = workflowRun({
      id: 676,
      path: COLD_RECOVERY_PATH,
      displayTitle: `Permanent staging cold recovery | quiesce | ${CANDIDATE}`,
      conclusion: "cancelled",
      createdAt: "2026-08-14T01:10:00.000Z",
    });
    const current = workflowRun({
      id: 677,
      path: COLD_RECOVERY_PATH,
      displayTitle:
        `Permanent staging cold recovery | reconcile-quiesce | ${CANDIDATE}`,
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    const extraReconcile = workflowRun({
      id: 674,
      path: COLD_RECOVERY_PATH,
      displayTitle:
        `Permanent staging cold recovery | reconcile-quiesce | ${CANDIDATE}`,
      conclusion: "failure",
      createdAt: "2026-08-14T01:30:00.000Z",
    });
    await expect(harness({
      operation: "cold-recovery-reconcile-quiesce",
      coldRecoveryRuns: [prepare, ambiguous, extraReconcile, current],
      jobEvidence: { 676: jobs(ambiguous, "cancelled") },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_reconciliation_history_invalid",
    );
    await expect(harness({
      operation: "cold-recovery-reconcile-quiesce",
      coldRecoveryRuns: [prepare, ambiguous, extraReconcile, current],
      jobEvidence: {
        676: jobs(ambiguous, "cancelled"),
        674: jobs(extraReconcile, "failure"),
      },
    }).verify()).resolves.toMatchObject({
      safePriorReadOnlyRunIds: ["674"],
      priorAmbiguousColdQuiesceRunId: "676",
    });
    await expect(harness({
      operation: "cold-recovery-reconcile-quiesce",
      coldRecoveryRuns: [prepare, ambiguous, current],
      jobEvidence: { 676: jobs(ambiguous, "skipped") },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_reconciliation_history_invalid",
    );
    const wrongSibling = jobs(ambiguous, "cancelled") as {
      jobs: Array<{ name: string; conclusion: string }>;
    };
    wrongSibling.jobs.find((job) => job.name ===
      "Bind the exact replacement and prepare the dead baseline")!.conclusion =
      "success";
    await expect(harness({
      operation: "cold-recovery-reconcile-quiesce",
      coldRecoveryRuns: [prepare, ambiguous, current],
      jobEvidence: { 676: wrongSibling },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_reconciliation_history_invalid",
    );
  });

  it("carries a reconciled cold prepare and bounded read-only retry into quiesce recovery", async () => {
    const ambiguousPrepare = workflowRun({
      id: 670,
      path: COLD_RECOVERY_PATH,
      displayTitle: `Permanent staging cold recovery | prepare | ${CANDIDATE}`,
      conclusion: "cancelled",
      createdAt: "2026-08-14T00:40:00.000Z",
    });
    const failedPrepareReconcile = workflowRun({
      id: 671,
      path: COLD_RECOVERY_PATH,
      displayTitle:
        `Permanent staging cold recovery | reconcile-prepare | ${CANDIDATE}`,
      conclusion: "failure",
      createdAt: "2026-08-14T00:55:00.000Z",
    });
    const selectedPrepare = workflowRun({
      id: 675,
      path: COLD_RECOVERY_PATH,
      displayTitle:
        `Permanent staging cold recovery | reconcile-prepare | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:10:00.000Z",
    });
    const ambiguousQuiesce = workflowRun({
      id: 676,
      path: COLD_RECOVERY_PATH,
      displayTitle: `Permanent staging cold recovery | quiesce | ${CANDIDATE}`,
      conclusion: "cancelled",
      createdAt: "2026-08-14T01:30:00.000Z",
    });
    const current = workflowRun({
      id: 677,
      path: COLD_RECOVERY_PATH,
      displayTitle:
        `Permanent staging cold recovery | reconcile-quiesce | ${CANDIDATE}`,
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    await expect(harness({
      operation: "cold-recovery-reconcile-quiesce",
      coldRecoveryRuns: [
        ambiguousPrepare,
        failedPrepareReconcile,
        selectedPrepare,
        ambiguousQuiesce,
        current,
      ],
      jobEvidence: {
        670: jobs(ambiguousPrepare, "cancelled"),
        671: jobs(failedPrepareReconcile, "failure"),
        675: jobs(selectedPrepare, "success"),
        676: jobs(ambiguousQuiesce, "cancelled"),
      },
    }).verify()).resolves.toMatchObject({
      selectedColdPrepareRunId: "675",
      priorAmbiguousColdQuiesceRunId: "676",
      safePriorReadOnlyRunIds: ["671"],
    });
  });

  it.each([
    [
      "cold-recovery-reconcile-prepare",
      "673",
      {
        priorAmbiguousColdPrepareRunId: "673",
        exactPriorColdPrepareCandidateRunBound: true,
        secondColdPrepareWritePreventedExact: true,
      },
    ],
    [
      "staging-worker-bootstrap-reconcile-restore",
      "679",
      {
        priorAmbiguousStagingRestoreRunId: "679",
        exactPriorStagingRestoreCandidateRunBound: true,
        secondStagingRestoreScaleWritePreventedExact: true,
      },
    ],
    [
      "staging-worker-fence-reconcile-activate",
      "689",
      {
        priorAmbiguousStagingActivateRunId: "689",
        exactPriorStagingActivateCandidateRunBound: true,
        secondStagingActivateVariableWritePreventedExact: true,
      },
    ],
  ])(
    "authorizes %s only as an exact read-only runner-loss convergence",
    async (operation, priorRunId, expected) => {
      await expect(harness({ operation, priorRunId }).verify()).resolves.toMatchObject({
        operation,
        ...expected,
        runnerLossRecoveryOriginalRunCompletedAt:
          "2026-08-14T01:20:00.000Z",
        runnerLossRecoveryGraceHours: 24,
        runnerLossRecoveryWithinGraceExact: true,
        reviewedAuthorityExact: true,
      });

      const fixture = harness({ operation, priorRunId: "999" });
      await expect(fixture.verify()).rejects.toThrow(
        "github_reviewed_candidate_authority_runner_loss_reconciliation_history_invalid",
      );
    },
  );

  it("keeps runner-loss recovery inside a fixed grace from the original write", async () => {
    const predecessor = workflowRun({
      id: 678,
      path: STAGING_BOOTSTRAP_PATH,
      displayTitle: `Permanent staging worker bootstrap | quiesce | ${CANDIDATE}`,
      createdAt: "2026-08-20T23:40:00.000Z",
    });
    const ambiguous = workflowRun({
      id: 679,
      path: STAGING_BOOTSTRAP_PATH,
      displayTitle: `Permanent staging worker bootstrap | restore | ${CANDIDATE}`,
      conclusion: "cancelled",
      createdAt: "2026-08-21T00:20:00.000Z",
      updatedAt: "2026-08-21T00:30:00.000Z",
    });
    const currentListing = workflowRun({
      id: 680,
      path: STAGING_BOOTSTRAP_PATH,
      displayTitle:
        `Permanent staging worker bootstrap | reconcile-restore | ${CANDIDATE}`,
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-22T00:30:00.000Z",
      updatedAt: "2026-08-22T00:31:00.000Z",
    });
    const base = {
      operation: "staging-worker-bootstrap-reconcile-restore",
      priorRunId: "679",
      mergedAt: "2026-08-14T00:30:00.000Z",
      bootstrapRuns: [predecessor, ambiguous, currentListing],
      current: {
        created_at: currentListing.created_at,
        run_started_at: currentListing.run_started_at,
        updated_at: currentListing.updated_at,
      },
      jobEvidence: { 679: jobs(ambiguous, "cancelled") },
    };
    await expect(harness(base).verify()).resolves.toMatchObject({
      runnerLossRecoveryWithinGraceExact: true,
    });
    const outside = workflowRun({
      ...{
        id: 680,
        path: STAGING_BOOTSTRAP_PATH,
        displayTitle:
          `Permanent staging worker bootstrap | reconcile-restore | ${CANDIDATE}`,
        status: "in_progress",
        conclusion: null,
        createdAt: "2026-08-22T00:30:00.001Z",
        updatedAt: "2026-08-22T00:31:00.000Z",
      },
    });
    await expect(harness({
      ...base,
      bootstrapRuns: [predecessor, ambiguous, outside],
      current: {
        created_at: outside.created_at,
        run_started_at: outside.run_started_at,
        updated_at: outside.updated_at,
      },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_runner_loss_reconciliation_grace_expired",
    );
  });

  it("allows bounded failed read-only convergence attempts before one final restore proof", async () => {
    const predecessor = workflowRun({
      id: 678,
      path: STAGING_BOOTSTRAP_PATH,
      displayTitle: `Permanent staging worker bootstrap | quiesce | ${CANDIDATE}`,
      createdAt: "2026-08-14T00:45:00.000Z",
    });
    const ambiguous = workflowRun({
      id: 679,
      path: STAGING_BOOTSTRAP_PATH,
      displayTitle: `Permanent staging worker bootstrap | restore | ${CANDIDATE}`,
      conclusion: "cancelled",
      createdAt: "2026-08-14T01:10:00.000Z",
    });
    const failedReadOnly = workflowRun({
      id: 681,
      path: STAGING_BOOTSTRAP_PATH,
      displayTitle:
        `Permanent staging worker bootstrap | reconcile-restore | ${CANDIDATE}`,
      conclusion: "failure",
      createdAt: "2026-08-14T01:30:00.000Z",
    });
    const current = workflowRun({
      id: 680,
      path: STAGING_BOOTSTRAP_PATH,
      displayTitle:
        `Permanent staging worker bootstrap | reconcile-restore | ${CANDIDATE}`,
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    await expect(harness({
      operation: "staging-worker-bootstrap-reconcile-restore",
      priorRunId: "679",
      bootstrapRuns: [predecessor, ambiguous, failedReadOnly, current],
      jobEvidence: {
        679: jobs(ambiguous, "cancelled"),
        681: jobs(failedReadOnly, "failure"),
      },
    }).verify()).resolves.toMatchObject({
      safePriorReadOnlyRunIds: ["681"],
      priorAmbiguousStagingRestoreRunId: "679",
    });
    failedReadOnly.updated_at = "2026-08-14T02:01:00.000Z";
    await expect(harness({
      operation: "staging-worker-bootstrap-reconcile-restore",
      priorRunId: "679",
      bootstrapRuns: [predecessor, ambiguous, failedReadOnly, current],
      jobEvidence: {
        679: jobs(ambiguous, "cancelled"),
        681: jobs(failedReadOnly, "failure"),
      },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_runner_loss_reconciliation_history_invalid",
    );
  });

  it.each([
    ["cold-recovery-prepare", "prepare", 675],
    ["cold-recovery-quiesce", "quiesce", 676],
  ])(
    "allows a %s retry only when the exact prior cold write step was skipped",
    async (operation, coldOperation, currentId) => {
      const current = workflowRun({
        id: currentId,
        path: COLD_RECOVERY_PATH,
        displayTitle:
          `Permanent staging cold recovery | ${coldOperation} | ${CANDIDATE}`,
        status: "in_progress",
        conclusion: null,
        createdAt: "2026-08-14T02:00:00.000Z",
      });
      const prior = workflowRun({
        id: currentId - 10,
        path: COLD_RECOVERY_PATH,
        displayTitle:
          `Permanent staging cold recovery | ${coldOperation} | ${CANDIDATE}`,
        conclusion: "failure",
        createdAt: "2026-08-14T01:30:00.000Z",
      });
      await expect(harness({
        operation,
        coldRecoveryRuns: [prior, current],
        jobEvidence: { [prior.id]: jobs(prior, "skipped") },
      }).verify()).resolves.toMatchObject({
        safePriorSkippedWriteRunIds: [String(prior.id)],
      });
      for (const evidence of [
        jobs(prior, "failure"),
        { total_count: 0, jobs: [] },
      ]) {
        await expect(harness({
          operation,
          coldRecoveryRuns: [prior, current],
          jobEvidence: { [prior.id]: evidence },
        }).verify()).rejects.toThrow(
          "github_reviewed_candidate_authority_prior_write_ambiguous",
        );
      }
    },
  );

  it("binds cold prepare to one selected successful key-replacement run", async () => {
    const selected = workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      createdAt: "2026-08-14T00:45:00.000Z",
    });
    await expect(harness({
      operation: "cold-recovery-prepare",
      providerRuns: [selected],
      replacementRunId: "500",
    }).verify()).resolves.toMatchObject({
      selectedReplacementRunId: "500",
      safeSkippedReplacementRunIds: [],
    });
    await expect(harness({
      operation: "cold-recovery-prepare",
      providerRuns: [selected],
      replacementRunId: "501",
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_replacement_history_invalid",
    );
  });

  it("binds the protected off-site cleanup as its own candidate operation", async () => {
    await expect(harness({
      operation: "remove-forbidden-offsite-backup-variables",
    }).verify()).resolves.toMatchObject({
      operation: "remove-forbidden-offsite-backup-variables",
      workflowRunId: "500",
      safePriorSkippedWriteRunIds: [],
      reviewedAuthorityExact: true,
    });
  });

  it.each([
    "resume-forbidden-offsite-backup-deletion-patch",
    "cancel-forbidden-offsite-backup-deletion-patch",
  ])(
    "binds %s to one exact prior ambiguous cleanup and exact patch identity",
    async (operation) => {
      const current = workflowRun({
        id: 500,
        path: PROVIDER_PATH,
        displayTitle: title(operation),
        status: "in_progress",
        conclusion: null,
        createdAt: "2026-08-14T02:00:00.000Z",
      });
      const priorCleanup = workflowRun({
        id: 450,
        path: PROVIDER_PATH,
        displayTitle: title("remove-forbidden-offsite-backup-variables"),
        conclusion: "failure",
        createdAt: "2026-08-14T01:00:00.000Z",
      });
      await expect(harness({
        operation,
        priorRunId: "450",
        providerRuns: [priorCleanup, current],
        jobEvidence: { 450: jobs(priorCleanup, "failure") },
      }).verify()).resolves.toMatchObject({
        operation,
        priorCleanupRunId: "450",
        priorCleanupPatchSha256:
          "3650174bf695aaebb3b9ba7f91a4f2a724a0806b30511578448964c36eebfb91",
        exactPriorCleanupCandidateRunBound: true,
        offsiteCleanupRecoveryOriginalRunCompletedAt:
          "2026-08-14T01:10:00.000Z",
        offsiteCleanupRecoveryGraceHours: 24,
        offsiteCleanupRecoveryWithinGraceExact: true,
      });

      const priorSameModeRecovery = workflowRun({
        id: 440,
        path: PROVIDER_PATH,
        displayTitle: title(operation),
        conclusion: "failure",
        createdAt: "2026-08-14T01:30:00.000Z",
      });
      await expect(harness({
        operation,
        priorRunId: "450",
        providerRuns: [priorCleanup, priorSameModeRecovery, current],
        jobEvidence: {
          450: jobs(priorCleanup, "failure"),
          440: jobs(priorSameModeRecovery, "failure"),
        },
      }).verify()).resolves.toMatchObject({
        ambiguousPriorSameModeRecoveryRunIds: ["440"],
        sameModeRecoveryConvergenceExact: true,
      });

      const priorOppositeModeRecovery = workflowRun({
        id: 441,
        path: PROVIDER_PATH,
        displayTitle: title(
          operation === "resume-forbidden-offsite-backup-deletion-patch"
            ? "cancel-forbidden-offsite-backup-deletion-patch"
            : "resume-forbidden-offsite-backup-deletion-patch",
        ),
        conclusion: "failure",
        createdAt: "2026-08-14T01:30:00.000Z",
      });
      await expect(harness({
        operation,
        priorRunId: "450",
        providerRuns: [priorCleanup, priorOppositeModeRecovery, current],
        jobEvidence: {
          450: jobs(priorCleanup, "failure"),
          441: jobs(priorOppositeModeRecovery, "failure"),
        },
      }).verify()).rejects.toThrow(
        "github_reviewed_candidate_authority_prior_write_ambiguous",
      );

      const overlappingRecovery = workflowRun({
        id: 439,
        path: PROVIDER_PATH,
        displayTitle: title(operation),
        conclusion: "failure",
        createdAt: "2026-08-14T01:35:00.000Z",
      });
      priorSameModeRecovery.updated_at = "2026-08-14T01:50:00.000Z";
      await expect(harness({
        operation,
        priorRunId: "450",
        providerRuns: [
          priorCleanup,
          priorSameModeRecovery,
          overlappingRecovery,
          current,
        ],
        jobEvidence: {
          450: jobs(priorCleanup, "failure"),
          440: jobs(priorSameModeRecovery, "failure"),
          439: jobs(overlappingRecovery, "failure"),
        },
      }).verify()).rejects.toThrow(
        "github_reviewed_candidate_authority_cleanup_recovery_history_invalid",
      );
    },
  );

  it("limits OFFSITE convergence to 24 hours from the original cleanup", async () => {
    const priorCleanup = workflowRun({
      id: 450,
      path: PROVIDER_PATH,
      displayTitle: title("remove-forbidden-offsite-backup-variables"),
      conclusion: "failure",
      createdAt: "2026-08-21T00:20:00.000Z",
      updatedAt: "2026-08-21T00:30:00.000Z",
    });
    const recoveryAt = (createdAt: string) => workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle:
        title("resume-forbidden-offsite-backup-deletion-patch"),
      status: "in_progress",
      conclusion: null,
      createdAt,
      updatedAt: "2026-08-22T00:31:00.000Z",
    });
    const inside = recoveryAt("2026-08-22T00:30:00.000Z");
    const shared = {
      operation: "resume-forbidden-offsite-backup-deletion-patch",
      priorRunId: "450",
      mergedAt: "2026-08-14T00:30:00.000Z",
      jobEvidence: { 450: jobs(priorCleanup, "failure") },
    };
    await expect(harness({
      ...shared,
      providerRuns: [priorCleanup, inside],
      current: {
        created_at: inside.created_at,
        run_started_at: inside.run_started_at,
        updated_at: inside.updated_at,
      },
    }).verify()).resolves.toMatchObject({
      offsiteCleanupRecoveryWithinGraceExact: true,
    });
    const outside = recoveryAt("2026-08-22T00:30:00.001Z");
    await expect(harness({
      ...shared,
      providerRuns: [priorCleanup, outside],
      current: {
        created_at: outside.created_at,
        run_started_at: outside.run_started_at,
        updated_at: outside.updated_at,
      },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cleanup_recovery_history_invalid",
    );
  });

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

  it("rejects a repeated disable unless its write step was definitely skipped", async () => {
    const current = workflowRun({
      id: 600,
      path: CUTOVER_PATH,
      displayTitle: cutoverTitle(DISABLE_CUTOVER_MODE),
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    const prior = workflowRun({
      id: 550,
      path: CUTOVER_PATH,
      displayTitle: cutoverTitle(DISABLE_CUTOVER_MODE),
      status: "completed",
      conclusion: "failure",
      createdAt: "2026-08-14T01:30:00.000Z",
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      cutoverMode: DISABLE_CUTOVER_MODE,
      cutoverRuns: [current, prior],
      jobEvidence: { 550: jobs(prior, "skipped") },
    }).verify()).resolves.toMatchObject({ safePriorSkippedWriteRunIds: ["550"] });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      cutoverMode: DISABLE_CUTOVER_MODE,
      cutoverRuns: [current, prior],
      jobEvidence: { 550: jobs(prior, "failure") },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_prior_write_ambiguous",
    );
  });

  it("permits one mode-bound read-only reconciliation after an ambiguous disable", async () => {
    const current = workflowRun({
      id: 600,
      path: CUTOVER_PATH,
      displayTitle: cutoverTitle(RECONCILE_CUTOVER_MODE),
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    const ambiguousDisable = workflowRun({
      id: 550,
      path: CUTOVER_PATH,
      displayTitle: cutoverTitle(DISABLE_CUTOVER_MODE),
      conclusion: "failure",
      createdAt: "2026-08-14T01:30:00.000Z",
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      cutoverMode: RECONCILE_CUTOVER_MODE,
      cutoverRuns: [current, ambiguousDisable],
      jobEvidence: { 550: jobs(ambiguousDisable, "failure") },
    }).verify()).resolves.toMatchObject({
      cutoverMode: RECONCILE_CUTOVER_MODE,
      reconciledPriorAmbiguousDisableRunId: "550",
      secondCutoverWritePreventedExact: true,
      safePriorSkippedWriteRunIds: [],
    });

    const secondAmbiguousDisable = workflowRun({
      id: 540,
      path: CUTOVER_PATH,
      displayTitle: cutoverTitle(DISABLE_CUTOVER_MODE),
      conclusion: "cancelled",
      createdAt: "2026-08-14T01:20:00.000Z",
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      cutoverMode: RECONCILE_CUTOVER_MODE,
      cutoverRuns: [current, ambiguousDisable, secondAmbiguousDisable],
      jobEvidence: {
        550: jobs(ambiguousDisable, "failure"),
        540: jobs(secondAmbiguousDisable, "cancelled"),
      },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_prior_write_ambiguous",
    );
  });

  it("classifies prior reconcile runs as read-only and never as write authority", async () => {
    const current = workflowRun({
      id: 600,
      path: CUTOVER_PATH,
      displayTitle: cutoverTitle(DISABLE_CUTOVER_MODE),
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    const priorReadOnly = workflowRun({
      id: 550,
      path: CUTOVER_PATH,
      displayTitle: cutoverTitle(RECONCILE_CUTOVER_MODE),
      conclusion: "failure",
      createdAt: "2026-08-14T01:30:00.000Z",
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      cutoverMode: DISABLE_CUTOVER_MODE,
      cutoverRuns: [current, priorReadOnly],
    }).verify()).resolves.toMatchObject({
      cutoverMode: DISABLE_CUTOVER_MODE,
      safePriorReadOnlyRunIds: ["550"],
    });
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
        updated_at: "2026-08-21T00:30:01.000Z",
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
        updated_at: "2026-08-21T00:30:01.000Z",
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

  it.each(["in_progress", "pending", "queued", "requested", "waiting"])(
    "accepts the exact current run while GitHub reports the nonterminal %s state",
    async (status) => {
      await expect(harness({
        current: { status, conclusion: null },
        runtimeRuns: undefined,
      }).verify()).resolves.toMatchObject({
        workflowRunId: "500",
      });
    },
  );

  it.each(["completed", "failure", "cancelled", "timed_out"])(
    "rejects a current run in terminal state %s",
    async (status) => {
      await expect(harness({
        current: { status, conclusion: status === "completed" ? "success" : status },
      }).verify()).rejects.toThrow(
        "github_reviewed_candidate_authority_current_run_invalid",
      );
    },
  );
});
