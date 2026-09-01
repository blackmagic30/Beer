import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseGithubReleaseChecksPolicy,
  readHeldPinnedEvidenceFile,
  runGithubReleaseCandidateVerification,
} from "../scripts/verify-github-release-candidate.mjs";

const CANDIDATE = "a".repeat(40);
const REVIEWED_PR_HEAD = "b".repeat(40);
const REVIEWED_TREE = "c".repeat(40);
const CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE =
  "0eadad05ce6c313ed3c12492d3095609ce5872d5";
const CLEANUP_CLOSEOUT_ANCHOR =
  "d939a77d0950b27466f3b9ecd26643a2416059a7";
const CLEANUP_CLOSEOUT_ANCHOR_TREE =
  "83b0b51efd2cf0ac5c2299c6cfd4c919d1973aff";
const POLICY = fs.readFileSync(
  path.resolve(".github/release-required-checks.json"),
  "utf8",
);
const temporaryDirectories: string[] = [];

function currentCandidateTimestamp(value: string): string {
  return value.replace(/^2026-08-14/, "2026-09-01");
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function artifact(name: string, runId: number) {
  const artifactId = runId * 100;
  return {
    id: artifactId,
    name,
    expired: false,
    size_in_bytes: 100,
    digest: `sha256:${crypto.createHash("sha256").update(name).digest("hex")}`,
    archive_download_url:
      `https://api.github.com/repos/blackmagic30/Beer/actions/artifacts/${artifactId}/zip`,
    workflow_run: { id: runId, head_sha: CANDIDATE },
  };
}

function mutationRun(input: {
  id: number;
  workflowPath: string;
  displayTitle: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  conclusion?: string | null;
  status?: string;
  runAttempt?: number;
  headSha?: string;
}) {
  return {
    id: input.id,
    repository: { full_name: "blackmagic30/Beer" },
    head_repository: { full_name: "blackmagic30/Beer" },
    head_sha: input.headSha ?? CANDIDATE,
    head_branch: "main",
    path: `${input.workflowPath}@main`,
    event: "workflow_dispatch",
    display_title: input.displayTitle,
    run_attempt: input.runAttempt ?? 1,
    status: input.status ?? "completed",
    conclusion: input.conclusion === undefined ? "success" : input.conclusion,
    created_at: currentCandidateTimestamp(input.createdAt),
    run_started_at: currentCandidateTimestamp(input.startedAt),
    updated_at: currentCandidateTimestamp(input.updatedAt),
  };
}

function coldRecoveryRun(
  operation:
    | "prepare"
    | "reconcile-prepare"
    | "quiesce"
    | "reconcile-quiesce",
  options: {
    id?: number;
    conclusion?: string | null;
    createdAt?: string;
    startedAt?: string;
    updatedAt?: string;
  } = {},
) {
  const prepare = operation === "prepare";
  const reconcilePrepare = operation === "reconcile-prepare";
  const reconcileQuiesce = operation === "reconcile-quiesce";
  return mutationRun({
    id: options.id ?? (prepare
      ? 710
      : reconcilePrepare
      ? 715
      : reconcileQuiesce
      ? 714
      : 711),
    workflowPath:
      ".github/workflows/recover-permanent-staging-cold-zero.yml",
    displayTitle:
      `Permanent staging cold recovery | ${operation} | ${CANDIDATE}`,
    createdAt: options.createdAt ?? (prepare
      ? "2026-08-14T01:01:00.000Z"
      : reconcilePrepare
      ? "2026-08-14T01:02:01.000Z"
      : reconcileQuiesce
      ? "2026-08-14T01:03:05.000Z"
      : "2026-08-14T01:02:05.000Z"),
    startedAt: options.startedAt ?? (prepare
      ? "2026-08-14T01:01:10.000Z"
      : reconcilePrepare
      ? "2026-08-14T01:02:02.000Z"
      : reconcileQuiesce
      ? "2026-08-14T01:03:10.000Z"
      : "2026-08-14T01:02:10.000Z"),
    updatedAt: options.updatedAt ?? (prepare
      ? "2026-08-14T01:02:00.000Z"
      : reconcilePrepare
      ? "2026-08-14T01:02:04.000Z"
      : reconcileQuiesce
      ? "2026-08-14T01:04:00.000Z"
      : "2026-08-14T01:03:00.000Z"),
    ...(options.conclusion === undefined
      ? {}
      : { conclusion: options.conclusion }),
  });
}

function coldRecoveryJobs(
  run: ReturnType<typeof coldRecoveryRun>,
  operation:
    | "prepare"
    | "reconcile-prepare"
    | "quiesce"
    | "reconcile-quiesce",
  selectedStepConclusion: string,
) {
  const configurations = [
    {
      operation: "prepare",
      jobName: "Bind the exact replacement and prepare the dead baseline",
      stepName: "Prepare the exact dead staging baseline once",
    },
    {
      operation: "reconcile-prepare",
      jobName: "Reconcile an ambiguous cold prepare at the exact dead baseline",
      stepName: "Prove the lost prepare acknowledgement without another write",
    },
    {
      operation: "quiesce",
      jobName: "Initialize the exact dead baseline at explicit zero",
      stepName: "Initialize the dead baseline from null to explicit zero once",
    },
    {
      operation: "reconcile-quiesce",
      jobName: "Reconcile an ambiguous cold quiesce at exact zero",
      stepName:
        "Prove the ambiguous cold quiesce reached exact zero without a second write",
    },
  ];
  return {
    total_count: configurations.length,
    jobs: configurations.map((configuration) => {
      const selected = configuration.operation === operation;
      return {
        run_id: run.id,
        run_attempt: 1,
        name: configuration.jobName,
        status: "completed",
        conclusion: selected ? run.conclusion : "skipped",
        steps: selected
          ? [{
              name: configuration.stepName,
              status: "completed",
              conclusion: selectedStepConclusion,
            }]
          : [],
      };
    }),
  };
}

function stagingWorkerRun(
  operation: "prepare" | "activate" | "reconcile-activate",
  options: {
    id: number;
    conclusion?: string;
    createdAt: string;
    startedAt: string;
    updatedAt: string;
  },
) {
  return mutationRun({
    ...options,
    workflowPath:
      ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
    displayTitle:
      `Automatic maintenance worker fence | permanent-staging | ${operation} | ${CANDIDATE}`,
  });
}

function stagingBootstrapRun(
  operation: "quiesce" | "restore" | "reconcile-restore",
  options: {
    id: number;
    conclusion?: string;
    createdAt: string;
    startedAt: string;
    updatedAt: string;
  },
) {
  return mutationRun({
    ...options,
    workflowPath:
      ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
    displayTitle:
      `Permanent staging worker bootstrap | ${operation} | ${CANDIDATE}`,
  });
}

function twoJobDisposition(
  run: ReturnType<typeof mutationRun>,
  configurations: Array<{ jobName: string; stepName: string }>,
  selectedJobName: string,
  selectedStepConclusion: string,
) {
  return {
    total_count: configurations.length,
    jobs: configurations.map((configuration) => {
      const selected = configuration.jobName === selectedJobName;
      return {
        run_id: run.id,
        run_attempt: 1,
        name: configuration.jobName,
        status: "completed",
        conclusion: selected ? run.conclusion : "skipped",
        steps: selected
          ? [{
              name: configuration.stepName,
              status: "completed",
              conclusion: selectedStepConclusion,
            }]
          : [],
      };
    }),
  };
}

const WORKER_JOB_FIXTURES = [
  {
    jobName: "One candidate-bound automatic-maintenance transition",
    stepName: "Execute at most one exact atomic Railway variable upsert",
  },
  {
    jobName: "Reconcile an ambiguous staging automatic-maintenance activation",
    stepName: "Prove the lost activation acknowledgement without another write",
  },
];
const BOOTSTRAP_JOB_FIXTURES = [
  {
    jobName: "Verify the chain and perform one exact protected scale transition",
    stepName: "Perform at most one exact candidate-bound scale transition",
  },
  {
    jobName: "Reconcile an ambiguous staging bootstrap restore at exact one",
    stepName:
      "Prove the ambiguous restore reached exact one without a second write",
  },
];

function providerMutationJobs(
  run: ReturnType<typeof mutationRun>,
  selectedStepConclusion: string,
) {
  return {
    total_count: 1,
    jobs: [{
      run_id: run.id,
      run_attempt: 1,
      name: "One protected variable mutation plan",
      status: "completed",
      conclusion: run.conclusion,
      steps: [{
        name: "Execute one reviewed protected Railway mutation plan",
        status: "completed",
        conclusion: selectedStepConclusion,
      }],
    }],
  };
}

function cleanupSuccessorCloseoutJobs(
  run: ReturnType<typeof mutationRun>,
  overrides: {
    writerConclusion?: string;
    closeoutConclusion?: string;
    boundaryConclusion?: string;
    uploadConclusion?: string;
  } = {},
) {
  return {
    total_count: 1,
    jobs: [{
      run_id: run.id,
      run_attempt: 1,
      name: "One protected variable mutation plan",
      status: "completed",
      conclusion: run.conclusion,
      steps: [
        {
          name: "Execute one reviewed protected Railway mutation plan",
          status: "completed",
          conclusion: overrides.writerConclusion ?? "skipped",
        },
        {
          name: "Reconcile the completed cleanup with metadata only",
          status: "completed",
          conclusion: overrides.closeoutConclusion ?? "success",
        },
        {
          name: "Reconcile the Railway mutation boundary after every attempt",
          status: "completed",
          conclusion: overrides.boundaryConclusion ?? "success",
        },
        {
          name: "Upload secret-free terminal evidence",
          status: "completed",
          conclusion: overrides.uploadConclusion ?? "success",
        },
      ],
    }],
  };
}

function harness(
  options: {
    phase?: "staging" | "production" | "close" | "activation" | "promotion-recovery" | "open" | "release";
    omitCheck?: string;
    omitArtifact?: string;
    duplicateCheck?: string;
    additionalWrongIdentityCheck?: string;
    wrongEventOnlyCheck?: string;
    wrongWorkflowOnlyCheck?: string;
    untrustedDuplicateCheck?: string;
    chronologyOverlapStage?: string;
    currentWorkflowPath?: string;
    currentEvent?: "push" | "workflow_dispatch";
    currentRunAttempt?: number;
    currentRunId?: number;
    predecessorRunAttempt?: number;
    associatedPullCount?: number;
    associatedPullPages?: Array<Array<Record<string, unknown>>>;
    pullMergeCommitSha?: string;
    pullHeadSha?: string;
    pullMerged?: boolean;
    pullDraft?: boolean;
    pullBaseRef?: string;
    pullBaseRepository?: string;
    pullHeadRepository?: string;
    pullAuthorId?: number;
    pullMergedById?: number;
    candidateTreeSha?: string;
    reviewedTreeSha?: string;
    candidateParentCount?: number;
    candidateParentSha?: string;
    anchorParentSha?: string;
    anchorTreeSha?: string;
    comparison?: Record<string, unknown>;
    comparisonUnavailable?: boolean;
    additionalStagingDeployments?: Array<{
      runId: number;
      startedAt: string;
      completedAt: string;
      runStartedAt: string;
    }>;
    providerMutationRuns?: Array<Record<string, unknown>>;
    runtimeMutationRuns?: Array<Record<string, unknown>>;
    workerFenceRuns?: Array<Record<string, unknown>>;
    stagingBootstrapRuns?: Array<Record<string, unknown>>;
    coldRecoveryRuns?: Array<Record<string, unknown>>;
    venueDirectoryRuns?: Array<Record<string, unknown>>;
    stagingBootstrapPath?: "normal" | "cold";
    mutationJobs?: Record<number, unknown>;
    mergedAt?: string;
  } = {},
) {
  type RequiredCheck = {
    stage?: string;
    name: string;
    workflowPath: string;
    event: "push" | "workflow_dispatch";
  };
  type RequiredArtifact = {
    stage?: string;
    name: string;
    producerCheck: string;
  };
  const policy = JSON.parse(POLICY) as {
    phaseConsumers: Record<string, { workflowPath: string; event: "workflow_dispatch" }>;
    requiredChecks: Record<string, RequiredCheck[]>;
    requiredArtifacts: Record<string, RequiredArtifact[]>;
  };
  const phase = options.phase ?? "release";
  const requiredChecks = [...policy.requiredChecks.base];
  const artifactRequirements = [...policy.requiredArtifacts.base];
  if (phase !== "staging") {
    requiredChecks.push(...policy.requiredChecks.staging);
    artifactRequirements.push(...policy.requiredArtifacts.staging);
  }
  const stageCounts = {
    staging: 0,
    production: 0,
    close: 2,
    activation: 3,
    "promotion-recovery": 4,
    open: 5,
    release: 6,
  };
  requiredChecks.push(...policy.requiredChecks.production.slice(0, stageCounts[phase]));
  artifactRequirements.push(
    ...policy.requiredArtifacts.production.slice(0, stageCounts[phase]),
  );
  const expandedArtifacts = artifactRequirements.map((item) => ({
    ...item,
    name: item.name.replaceAll("{candidateSha}", CANDIDATE),
  }));
  const runByCheck = new Map(
    requiredChecks.map((check, index) => [check.name, index + 100]),
  );
  const runFixtures = new Map<number, RequiredCheck>();
  const runStartedAtById = new Map<number, string>();
  const checks = requiredChecks
    .filter((check) => check.name !== options.omitCheck)
    .flatMap((check) => {
      const runId = runByCheck.get(check.name)!;
      runFixtures.set(runId, {
        ...check,
        event:
          options.wrongEventOnlyCheck === check.name
            ? check.event === "push"
              ? "workflow_dispatch"
              : "push"
            : check.event,
        workflowPath:
          options.wrongWorkflowOnlyCheck === check.name
            ? ".github/workflows/venue-directory-refresh.yml"
            : check.workflowPath,
      });
      const venueDirectoryCheck =
        check.name === "Apply and prove permanent-staging venue directory";
      const checkStartedAt = venueDirectoryCheck
        ? "2026-09-01T01:08:30.100Z"
        : new Date(Date.UTC(2026, 8, 1, 1, runId - 100, 0)).toISOString();
      const checkCompletedAt = venueDirectoryCheck
        ? "2026-09-01T01:08:30.400Z"
        : new Date(Date.UTC(
          2026,
          8,
          1,
          1,
          options.chronologyOverlapStage !== undefined &&
              options.chronologyOverlapStage === check.stage
            ? 59
            : runId - 100,
          30,
        )).toISOString();
      if (venueDirectoryCheck) {
        runStartedAtById.set(runId, "2026-09-01T01:08:30.050Z");
      }
      const value = {
        name: check.name,
        head_sha: CANDIDATE,
        status: "completed",
        conclusion: "success",
        started_at: checkStartedAt,
        completed_at: checkCompletedAt,
        app: { slug: "github-actions" },
        check_suite: { id: runId + 10_000 },
        details_url: `https://github.com/blackmagic30/Beer/actions/runs/${runId}/job/1`,
      };
      const values =
        options.duplicateCheck === check.name ? [value, { ...value }] : [value];
      if (options.additionalWrongIdentityCheck === check.name) {
        const shadowRunId = runId + 1_000;
        runFixtures.set(shadowRunId, {
          ...check,
          event: check.event === "push" ? "workflow_dispatch" : "push",
          workflowPath: ".github/workflows/venue-directory-refresh.yml",
        });
        values.push({
          ...value,
          check_suite: { id: shadowRunId + 10_000 },
          details_url: `https://github.com/blackmagic30/Beer/actions/runs/${shadowRunId}/job/1`,
        });
      }
      if (options.untrustedDuplicateCheck === check.name) {
        values.push({ ...value, app: { slug: "untrusted-check-app" } });
      }
      return values;
    });
  const artifactRunByCheck = new Map(runByCheck);
  const defaultAdditionalStagingDeployments = requiredChecks.some((item) =>
      item.name === "Deploy permanent staging")
    ? [{
      runId: 900,
      runStartedAt: "2026-08-14T01:08:35.000Z",
      startedAt: "2026-08-14T01:08:40.000Z",
      completedAt: "2026-08-14T01:08:50.000Z",
    }]
    : [];
  for (const extra of
    options.additionalStagingDeployments ?? defaultAdditionalStagingDeployments) {
    const check = requiredChecks.find((item) => item.name === "Deploy permanent staging");
    if (!check) throw new Error("staging deployment fixture unavailable");
    const runStartedAt = currentCandidateTimestamp(extra.runStartedAt);
    const startedAt = currentCandidateTimestamp(extra.startedAt);
    const completedAt = currentCandidateTimestamp(extra.completedAt);
    runFixtures.set(extra.runId, check);
    runStartedAtById.set(extra.runId, runStartedAt);
    artifactRunByCheck.set(check.name, extra.runId);
    checks.push({
      name: check.name,
      head_sha: CANDIDATE,
      status: "completed",
      conclusion: "success",
      started_at: startedAt,
      completed_at: completedAt,
      app: { slug: "github-actions" },
      check_suite: { id: extra.runId + 10_000 },
      details_url:
        `https://github.com/blackmagic30/Beer/actions/runs/${extra.runId}/job/1`,
    });
  }
  const hasStagingChain = requiredChecks.some((item) =>
      item.name === "Deploy permanent staging");
  const providerMutationRuns = options.providerMutationRuns ?? [];
  const stagingBootstrapPath = options.stagingBootstrapPath ?? "normal";
  const defaultWorkerFenceRuns = hasStagingChain
    ? stagingBootstrapPath === "normal"
      ? [
      mutationRun({
        id: 710,
        workflowPath:
          ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
        displayTitle:
          `Automatic maintenance worker fence | permanent-staging | prepare | ${CANDIDATE}`,
        createdAt: "2026-08-14T01:01:00.000Z",
        startedAt: "2026-08-14T01:01:10.000Z",
        updatedAt: "2026-08-14T01:02:00.000Z",
      }),
      mutationRun({
        id: 713,
        workflowPath:
          ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
        displayTitle:
          `Automatic maintenance worker fence | permanent-staging | activate | ${CANDIDATE}`,
        createdAt: "2026-08-14T01:08:32.000Z",
        startedAt: "2026-08-14T01:08:33.000Z",
        updatedAt: "2026-08-14T01:08:34.000Z",
      }),
    ]
      : [
        mutationRun({
          id: 713,
          workflowPath:
            ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
          displayTitle:
            `Automatic maintenance worker fence | permanent-staging | activate | ${CANDIDATE}`,
          createdAt: "2026-08-14T01:08:32.000Z",
          startedAt: "2026-08-14T01:08:33.000Z",
          updatedAt: "2026-08-14T01:08:34.000Z",
        }),
      ]
    : [];
  const defaultStagingBootstrapRuns = hasStagingChain
    ? stagingBootstrapPath === "normal"
      ? [
      mutationRun({
        id: 711,
        workflowPath:
          ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
        displayTitle:
          `Permanent staging worker bootstrap | quiesce | ${CANDIDATE}`,
        createdAt: "2026-08-14T01:02:05.000Z",
        startedAt: "2026-08-14T01:02:10.000Z",
        updatedAt: "2026-08-14T01:03:00.000Z",
      }),
      mutationRun({
        id: 712,
        workflowPath:
          ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
        displayTitle:
          `Permanent staging worker bootstrap | restore | ${CANDIDATE}`,
        createdAt: "2026-08-14T01:08:30.500Z",
        startedAt: "2026-08-14T01:08:31.000Z",
        updatedAt: "2026-08-14T01:08:32.000Z",
      }),
    ]
      : [
        mutationRun({
          id: 712,
          workflowPath:
            ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
          displayTitle:
            `Permanent staging worker bootstrap | restore | ${CANDIDATE}`,
          createdAt: "2026-08-14T01:08:30.500Z",
          startedAt: "2026-08-14T01:08:31.000Z",
          updatedAt: "2026-08-14T01:08:32.000Z",
        }),
      ]
    : [];
  const defaultColdRecoveryRuns = hasStagingChain &&
      stagingBootstrapPath === "cold"
    ? [
      coldRecoveryRun("prepare"),
      coldRecoveryRun("quiesce"),
    ]
    : [];
  const venueDirectoryRunId = runByCheck.get(
    "Apply and prove permanent-staging venue directory",
  );
  const defaultVenueDirectoryRuns = hasStagingChain && venueDirectoryRunId
    ? [mutationRun({
      id: venueDirectoryRunId,
      workflowPath:
        ".github/workflows/permanent-staging-venue-directory.yml",
      displayTitle:
        `Permanent staging venue directory | apply-refresh-validate | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:08:30.000Z",
      startedAt: "2026-08-14T01:08:30.050Z",
      updatedAt: "2026-08-14T01:08:30.450Z",
    })]
    : [];
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes(`/commits/${CANDIDATE}/pulls?`)) {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const pull = {
        number: 24,
        state: "closed",
        merge_commit_sha: options.pullMergeCommitSha ?? CANDIDATE,
        base: {
          ref: options.pullBaseRef ?? "main",
          repo: {
            full_name: options.pullBaseRepository ?? "blackmagic30/Beer",
          },
        },
        head: {
          repo: {
            full_name: options.pullHeadRepository ?? "blackmagic30/Beer",
          },
        },
      };
      return jsonResponse(options.associatedPullPages?.[page - 1] ??
        (page === 1
          ? Array.from(
              { length: options.associatedPullCount ?? 1 },
              (_, index) => ({ ...pull, number: 24 + index }),
            )
          : []));
    }
    if (url.endsWith("/pulls/24")) {
      return jsonResponse({
        number: 24,
        state: "closed",
        merged: options.pullMerged ?? true,
        draft: options.pullDraft ?? false,
        merge_commit_sha: options.pullMergeCommitSha ?? CANDIDATE,
        merged_at: options.mergedAt ?? "2026-09-01T01:00:00.000Z",
        user: { id: options.pullAuthorId ?? 101 },
        merged_by: { id: options.pullMergedById ?? 202 },
        base: {
          ref: options.pullBaseRef ?? "main",
          repo: {
            full_name: options.pullBaseRepository ?? "blackmagic30/Beer",
          },
        },
        head: {
          sha: options.pullHeadSha ?? REVIEWED_PR_HEAD,
          repo: {
            full_name: options.pullHeadRepository ?? "blackmagic30/Beer",
          },
        },
      });
    }
    if (url.endsWith(`/git/commits/${CANDIDATE}`)) {
      return jsonResponse({
        sha: CANDIDATE,
        tree: { sha: options.candidateTreeSha ?? REVIEWED_TREE },
        parents: Array.from(
          { length: options.candidateParentCount ?? 1 },
          (_, index) => index === 0
            ? options.candidateParentSha ?? CLEANUP_CLOSEOUT_ANCHOR
            : String(index + 1).repeat(40),
        ).map((sha) => ({ sha })),
      });
    }
    if (url.endsWith(`/git/commits/${options.pullHeadSha ?? REVIEWED_PR_HEAD}`)) {
      return jsonResponse({
        sha: options.pullHeadSha ?? REVIEWED_PR_HEAD,
        tree: { sha: options.reviewedTreeSha ?? REVIEWED_TREE },
        parents: [{ sha: "d".repeat(40) }],
      });
    }
    if (url.endsWith(`/git/commits/${CLEANUP_CLOSEOUT_ANCHOR}`)) {
      return jsonResponse({
        sha: CLEANUP_CLOSEOUT_ANCHOR,
        tree: {
          sha: options.anchorTreeSha ?? CLEANUP_CLOSEOUT_ANCHOR_TREE,
        },
        parents: [{
          sha: options.anchorParentSha ?? CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE,
        }],
      });
    }
    if (url.includes(
      `/compare/${CLEANUP_CLOSEOUT_ANCHOR}...${CANDIDATE}`,
    )) {
      if (options.comparisonUnavailable) {
        return new Response("", { status: 503 });
      }
      return jsonResponse(options.comparison ?? {
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        base_commit: { sha: CLEANUP_CLOSEOUT_ANCHOR },
        merge_base_commit: { sha: CLEANUP_CLOSEOUT_ANCHOR },
      });
    }
    if (url.includes("/check-runs?")) {
      const requestedName = new URL(url).searchParams.get("check_name");
      const matchingChecks = checks.filter(
        (check) => check.name === requestedName,
      );
      return jsonResponse({
        total_count: matchingChecks.length,
        check_runs: matchingChecks,
      });
    }
    if (url.includes(
      "/actions/workflows/permanent-staging-provider-mutation.yml/runs?",
    )) {
      const workflowRuns = providerMutationRuns;
      return jsonResponse({
        total_count: workflowRuns.length,
        workflow_runs: workflowRuns,
      });
    }
    if (url.includes("/actions/workflows/configure-runtime-variable.yml/runs?")) {
      const workflowRuns = options.runtimeMutationRuns ?? [];
      return jsonResponse({
        total_count: workflowRuns.length,
        workflow_runs: workflowRuns,
      });
    }
    if (url.includes(
      "/actions/workflows/configure-automatic-maintenance-worker-fence.yml/runs?",
    )) {
      const workflowRuns = options.workerFenceRuns ?? defaultWorkerFenceRuns;
      return jsonResponse({
        total_count: workflowRuns.length,
        workflow_runs: workflowRuns,
      });
    }
    if (url.includes(
      "/actions/workflows/bootstrap-permanent-staging-worker-fence.yml/runs?",
    )) {
      const workflowRuns = options.stagingBootstrapRuns ??
        defaultStagingBootstrapRuns;
      return jsonResponse({
        total_count: workflowRuns.length,
        workflow_runs: workflowRuns,
      });
    }
    if (url.includes(
      "/actions/workflows/recover-permanent-staging-cold-zero.yml/runs?",
    )) {
      const workflowRuns = options.coldRecoveryRuns ?? defaultColdRecoveryRuns;
      return jsonResponse({
        total_count: workflowRuns.length,
        workflow_runs: workflowRuns,
      });
    }
    if (url.includes(
      "/actions/workflows/permanent-staging-venue-directory.yml/runs?",
    )) {
      const workflowRuns = options.venueDirectoryRuns ??
        defaultVenueDirectoryRuns;
      return jsonResponse({
        total_count: workflowRuns.length,
        workflow_runs: workflowRuns,
      });
    }
    const jobsMatch = /\/actions\/runs\/(\d+)\/jobs\?/.exec(url);
    if (jobsMatch) {
      const runId = Number(jobsMatch[1]);
      return jsonResponse(options.mutationJobs?.[runId] ?? {
        total_count: 0,
        jobs: [],
      });
    }
    const runMatch = /\/actions\/runs\/(\d+)(?:\/artifacts)?/.exec(url);
    if (!runMatch) return new Response("", { status: 404 });
    const runId = Number(runMatch[1]);
    if (runId === 9_999) {
      const consumer = policy.phaseConsumers[phase];
      return jsonResponse({
        id: options.currentRunId ?? runId,
        head_sha: CANDIDATE,
        head_branch: "main",
        event: options.currentEvent ?? consumer.event,
        path: options.currentWorkflowPath ?? consumer.workflowPath,
        workflow_id: 29_999,
        run_attempt: options.currentRunAttempt ?? 1,
        run_started_at: "2026-09-01T02:00:00.000Z",
        status: "in_progress",
        conclusion: null,
        repository: { full_name: "blackmagic30/Beer" },
        head_repository: { full_name: "blackmagic30/Beer" },
      });
    }
    if (url.includes("/artifacts?")) {
      const values = expandedArtifacts
        .filter((item) => item.name !== options.omitArtifact)
        .filter((item) => artifactRunByCheck.get(item.producerCheck) === runId)
        .map((item) => artifact(item.name, runId));
      return jsonResponse({ total_count: values.length, artifacts: values });
    }
    const runFixture = runFixtures.get(runId);
    if (!runFixture) return new Response("", { status: 404 });
    return jsonResponse({
      id: runId,
      check_suite_id: runId + 10_000,
      head_sha: CANDIDATE,
      head_branch: "main",
      event: runFixture.event,
      path: runFixture.workflowPath,
      workflow_id: runId + 20_000,
      run_attempt: options.predecessorRunAttempt ?? 1,
      run_started_at: runStartedAtById.get(runId) ??
        new Date(Date.UTC(2026, 8, 1, 1, runId - 100, 0)).toISOString(),
      display_title: runFixture.name === "Deploy permanent staging"
        ? runId === artifactRunByCheck.get(runFixture.name)
          ? `Deploy permanent staging | active | ${CANDIDATE}`
          : `Deploy permanent staging | fenced | ${CANDIDATE}`
        : runFixture.name ===
              "Apply and prove permanent-staging venue directory"
          ? `Permanent staging venue directory | apply-refresh-validate | ${CANDIDATE}`
          : runFixture.name,
      status: "completed",
      conclusion: "success",
      repository: { full_name: "blackmagic30/Beer" },
      head_repository: { full_name: "blackmagic30/Beer" },
    });
  });
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "github-gate-test-")),
  );
  temporaryDirectories.push(directory);
  fs.chmodSync(directory, 0o700);
  return {
    argv: [
      "--candidate-sha",
      CANDIDATE,
      "--phase",
      phase,
      "--output",
      path.join(directory, "receipt.json"),
    ],
    directory,
    fetchImpl,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("GitHub release-candidate verifier", () => {
  it("accepts only the canonical current check/artifact policy", () => {
    expect(parseGithubReleaseChecksPolicy(POLICY)).not.toBeNull();
    expect(parseGithubReleaseChecksPolicy(POLICY.trimEnd())).toBeNull();
    expect(parseGithubReleaseChecksPolicy(`${POLICY}\n`)).toBeNull();
    expect(
      parseGithubReleaseChecksPolicy(
        POLICY.replace('"branch": "main"', '"branch": "develop"'),
      ),
    ).toBeNull();
    expect(
      parseGithubReleaseChecksPolicy(
        POLICY.replace('"event": "push"', '"event": "pull_request"'),
      ),
    ).toBeNull();
    expect(
      parseGithubReleaseChecksPolicy(
        POLICY.replace(
          '"workflowPath": ".github/workflows/ci.yml"',
          '"workflowPath": "../ci.yml"',
        ),
      ),
    ).toBeNull();
  });

  it("verifies successful same-SHA checks and artifacts for every phase", async () => {
    for (const phase of [
      "staging",
      "production",
      "close",
      "activation",
      "promotion-recovery",
      "open",
      "release",
    ] as const) {
      const fixture = harness({ phase });
      let summary = "";
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => {
          summary += value;
        },
      });
      expect(code, `${phase}:${summary}`).toBe(0);
      expect(JSON.parse(summary)).toMatchObject({ ok: true, phase });
      const receipt = JSON.parse(
        fs.readFileSync(path.join(fixture.directory, "receipt.json"), "utf8"),
      );
      expect(receipt).toMatchObject({
        schemaVersion: "pintpath-github-release-candidate-receipt/v5",
        phase,
        candidateSha: CANDIDATE,
        reviewedPullRequest: {
          number: 24,
          reviewedPrHeadSha: REVIEWED_PR_HEAD,
          mergeCommitSha: CANDIDATE,
          treeSha: REVIEWED_TREE,
          githubMergeExact: true,
          reviewedTreeExact: true,
          pullRequestApprovalRequirement: "not_required",
          pullRequestApprovalRequirementExact: true,
          linearHistoryExact: true,
        },
        consumer: {
          runId: 9_999,
          workflowPath: expect.stringContaining(".github/workflows/"),
          runAttempt: 1,
        },
        requiredChecksExact: true,
        requiredArtifactsExact: true,
        chronologyExact: true,
        currentConsumerExact: true,
      });
      expect(Object.keys(receipt.reviewedPullRequest)).toEqual([
        "number",
        "reviewedPrHeadSha",
        "mergeCommitSha",
        "treeSha",
        "mergedAt",
        "authorId",
        "mergedById",
        "githubMergeExact",
        "reviewedTreeExact",
        "pullRequestApprovalRequirement",
        "pullRequestApprovalRequirementExact",
        "linearHistoryExact",
      ]);
      expect(receipt.checks).toContainEqual(
        expect.objectContaining({
          name: "ios",
          workflowPath: ".github/workflows/native-apps.yml",
          event: "push",
          runAttempt: 1,
        }),
      );
      for (const request of fixture.fetchImpl.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.includes("/check-runs?"))) {
        expect(request).toContain("filter=all");
        expect(request).toContain("check_name=");
        expect(request).not.toContain("filter=latest");
      }
    }
  });

  it("accepts an authenticated squash merge whose reviewed PR head is not an ancestor", async () => {
    const fixture = harness();
    const code = await runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: () => undefined,
    });
    expect(code).toBe(0);
    expect(fixture.fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/git/commits/${REVIEWED_PR_HEAD}`),
      expect.anything(),
    );
  });

  it("paginates public associated-PR decoys and requires one exact merged PR", async () => {
    const exact = (number: number) => ({
      number,
      state: "closed",
      merge_commit_sha: CANDIDATE,
      base: { ref: "main", repo: { full_name: "blackmagic30/Beer" } },
      head: { repo: { full_name: "blackmagic30/Beer" } },
    });
    const decoys = Array.from({ length: 100 }, (_, index) => ({
      ...exact(1_000 + index),
      head: { repo: { full_name: `fork-${index}/Beer` } },
    }));
    const fixture = harness({ associatedPullPages: [decoys, [exact(24)]] });
    const code = await runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: () => undefined,
    });
    expect(code).toBe(0);
    expect(fixture.fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/commits/${CANDIDATE}/pulls?per_page=100&page=2`),
      expect.anything(),
    );

    const duplicate = harness({
      associatedPullPages: [decoys, [exact(24), exact(25)]],
    });
    let summary = "";
    const duplicateCode = await runGithubReleaseCandidateVerification(
      duplicate.argv,
      {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: duplicate.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      },
    );
    expect(duplicateCode).toBe(1);
    expect(JSON.parse(summary)).toMatchObject({
      ok: false,
      failureCode: "reviewed_pull_request_invalid",
    });
  });

  it("selects the latest unambiguous staging deployment before scale", async () => {
    const fixture = harness({
      additionalStagingDeployments: [{
        runId: 900,
        runStartedAt: "2026-08-14T01:08:35.000Z",
        startedAt: "2026-08-14T01:08:40.000Z",
        completedAt: "2026-08-14T01:08:50.000Z",
      }],
    });
    const code = await runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: () => undefined,
    });
    expect(code).toBe(0);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(fixture.directory, "receipt.json"), "utf8"),
    );
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      name: "Deploy permanent staging",
      runId: 900,
    }));
    expect(receipt.artifacts).toContainEqual(expect.objectContaining({
      name: `pintpath-permanent-staging-deployment-${CANDIDATE}`,
      runId: 900,
    }));
  });

  it("rejects a same-candidate staging deployment that overlaps or follows scale", async () => {
    for (const additionalStagingDeployment of [
      {
        runId: 900,
        runStartedAt: "2026-08-14T01:09:55.000Z",
        startedAt: "2026-08-14T01:09:59.000Z",
        completedAt: "2026-08-14T01:10:10.000Z",
      },
      {
        runId: 901,
        runStartedAt: "2026-08-14T01:10:05.000Z",
        startedAt: "2026-08-14T01:10:10.000Z",
        completedAt: "2026-08-14T01:10:20.000Z",
      },
    ]) {
      const fixture = harness({
        additionalStagingDeployments: [additionalStagingDeployment],
      });
      let summary = "";
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      });
      expect(code).toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "required_check_invalid",
      });
    }
  });

  it("requires exactly the initial and closeout staging deployments", async () => {
    const cases = [
      harness({ additionalStagingDeployments: [] }),
      harness({
        additionalStagingDeployments: [
          {
            runId: 900,
            runStartedAt: "2026-08-14T01:08:35.000Z",
            startedAt: "2026-08-14T01:08:40.000Z",
            completedAt: "2026-08-14T01:08:50.000Z",
          },
          {
            runId: 901,
            runStartedAt: "2026-08-14T01:08:51.000Z",
            startedAt: "2026-08-14T01:08:52.000Z",
            completedAt: "2026-08-14T01:08:55.000Z",
          },
        ],
      }),
      harness({
        additionalStagingDeployments: [{
          runId: 900,
          runStartedAt: "2026-08-14T01:08:20.000Z",
          startedAt: "2026-08-14T01:08:25.000Z",
          completedAt: "2026-08-14T01:08:30.000Z",
        }],
      }),
    ];
    for (const fixture of cases) {
      let summary = "";
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      });
      expect(code).toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "required_check_invalid",
      });
    }
  });

  it("rejects provider or staging-runtime writes not sealed by deployment two", async () => {
    const closeoutStartedAt = "2026-08-14T01:08:40.000Z";
    const provider = mutationRun({
      id: 700,
      workflowPath:
        ".github/workflows/permanent-staging-provider-mutation.yml",
      displayTitle:
        `Permanent staging provider mutation | provider-openai-api-key | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:08:35.000Z",
      startedAt: "2026-08-14T01:08:36.000Z",
      updatedAt: closeoutStartedAt,
    });
    const runtime = mutationRun({
      id: 701,
      workflowPath: ".github/workflows/configure-runtime-variable.yml",
      displayTitle:
        `Configure runtime variable | permanent-staging | SUPABASE_URL | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:08:35.000Z",
      startedAt: "2026-08-14T01:08:36.000Z",
      updatedAt: "2026-08-14T01:08:45.000Z",
    });
    for (const fixture of [
      harness({ providerMutationRuns: [provider] }),
      harness({ runtimeMutationRuns: [runtime] }),
    ]) {
      let summary = "";
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      });
      expect(code).toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "staging_mutation_after_closeout_deployment",
      });
    }

    const unrelatedProduction = mutationRun({
      id: 702,
      workflowPath: ".github/workflows/configure-runtime-variable.yml",
      displayTitle:
        `Configure runtime variable | production | SUPABASE_URL | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:08:35.000Z",
      startedAt: "2026-08-14T01:08:36.000Z",
      updatedAt: "2026-08-14T01:08:45.000Z",
      status: "in_progress",
      conclusion: null,
      runAttempt: 2,
    });
    const allowed = harness({ runtimeMutationRuns: [unrelatedProduction] });
    await expect(runGithubReleaseCandidateVerification(allowed.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: allowed.fetchImpl,
      writeOutput: () => undefined,
    })).resolves.toBe(0);
  });

  it("accepts same-mode OFFSITE recovery convergence and rejects a cross-mode retry", async () => {
    const cleanup = mutationRun({
      id: 720,
      workflowPath:
        ".github/workflows/permanent-staging-provider-mutation.yml",
      displayTitle:
        `Permanent staging provider mutation | remove-forbidden-offsite-backup-variables | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:04:00.000Z",
      startedAt: "2026-08-14T01:04:10.000Z",
      updatedAt: "2026-08-14T01:05:00.000Z",
      conclusion: "failure",
    });
    const priorRecovery = mutationRun({
      id: 721,
      workflowPath:
        ".github/workflows/permanent-staging-provider-mutation.yml",
      displayTitle:
        `Permanent staging provider mutation | resume-forbidden-offsite-backup-deletion-patch | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:05:10.000Z",
      startedAt: "2026-08-14T01:05:20.000Z",
      updatedAt: "2026-08-14T01:06:00.000Z",
      conclusion: "failure",
    });
    const recovery = mutationRun({
      id: 722,
      workflowPath:
        ".github/workflows/permanent-staging-provider-mutation.yml",
      displayTitle:
        `Permanent staging provider mutation | resume-forbidden-offsite-backup-deletion-patch | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:06:10.000Z",
      startedAt: "2026-08-14T01:06:20.000Z",
      updatedAt: "2026-08-14T01:07:00.000Z",
    });
    const mutationJob = (runId: number, conclusion = "failure") => ({
      total_count: 1,
      jobs: [{
        run_id: runId,
        run_attempt: 1,
        name: "One protected variable mutation plan",
        status: "completed",
        conclusion,
        steps: [{
          name: "Execute one reviewed protected Railway mutation plan",
          status: "completed",
          conclusion,
        }],
      }],
    });
    const fixture = harness({
      providerMutationRuns: [cleanup, priorRecovery, recovery],
      mutationJobs: {
        720: mutationJob(720),
        721: mutationJob(721),
      },
    });
    let summary = "";
    await expect(runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: (value: string) => { summary += value; },
    })).resolves.toBe(0);
    expect(JSON.parse(summary)).toMatchObject({ ok: true });

    const priorOppositeModeRecovery = mutationRun({
      id: 723,
      workflowPath:
        ".github/workflows/permanent-staging-provider-mutation.yml",
      displayTitle:
        `Permanent staging provider mutation | cancel-forbidden-offsite-backup-deletion-patch | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:05:10.000Z",
      startedAt: "2026-08-14T01:05:20.000Z",
      updatedAt: "2026-08-14T01:06:00.000Z",
      conclusion: "failure",
    });
    const crossMode = harness({
      providerMutationRuns: [cleanup, priorOppositeModeRecovery, recovery],
      mutationJobs: {
        720: mutationJob(720),
        723: mutationJob(723),
      },
    });
    let crossModeSummary = "";
    await expect(runGithubReleaseCandidateVerification(crossMode.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: crossMode.fetchImpl,
      writeOutput: (value: string) => { crossModeSummary += value; },
    })).resolves.toBe(1);
    expect(JSON.parse(crossModeSummary)).toMatchObject({
      ok: false,
      failureCode: "staging_mutation_history_invalid",
    });

    const skippedOppositeModeRecovery = mutationRun({
      id: 724,
      workflowPath:
        ".github/workflows/permanent-staging-provider-mutation.yml",
      displayTitle:
        `Permanent staging provider mutation | cancel-forbidden-offsite-backup-deletion-patch | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:06:01.000Z",
      startedAt: "2026-08-14T01:06:02.000Z",
      updatedAt: "2026-08-14T01:06:05.000Z",
      conclusion: "failure",
    });
    const harmlessSkippedCrossMode = harness({
      providerMutationRuns: [
        cleanup,
        priorRecovery,
        skippedOppositeModeRecovery,
        recovery,
      ],
      mutationJobs: {
        720: mutationJob(720),
        721: mutationJob(721),
        724: providerMutationJobs(skippedOppositeModeRecovery, "skipped"),
      },
    });
    await expect(runGithubReleaseCandidateVerification(
      harmlessSkippedCrossMode.argv,
      {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: harmlessSkippedCrossMode.fetchImpl,
        writeOutput: () => undefined,
      },
    )).resolves.toBe(0);
  });

  it("authenticates the durable cleanup closeout and accepts an unbounded descendant proof", async () => {
    const verify = async (fixture: ReturnType<typeof harness>) => {
      let summary = "";
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      });
      return { code, summary: JSON.parse(summary) as Record<string, unknown> };
    };
    const directDescendant = harness();
    await expect(verify(directDescendant)).resolves.toMatchObject({
      code: 0,
      summary: { ok: true },
    });
    await expect(verify(harness({
      candidateParentSha: "f".repeat(40),
      comparison: {
        status: "ahead",
        ahead_by: 10_000,
        behind_by: 0,
        base_commit: { sha: CLEANUP_CLOSEOUT_ANCHOR },
        merge_base_commit: { sha: CLEANUP_CLOSEOUT_ANCHOR },
      },
    }))).resolves.toMatchObject({ code: 0, summary: { ok: true } });
    const requestedUrls = directDescendant.fetchImpl.mock.calls.map(
      ([url]) => String(url),
    );
    expect(requestedUrls).toContainEqual(expect.stringContaining(
      `/git/commits/${CLEANUP_CLOSEOUT_ANCHOR}`,
    ));
    expect(requestedUrls).toContainEqual(expect.stringContaining(
      `/compare/${CLEANUP_CLOSEOUT_ANCHOR}...${CANDIDATE}`,
    ));
    expect(requestedUrls.some((url) =>
      url.includes("/actions/runs/33249810569"))).toBe(false);
  });

  it("rejects broken closeout ancestry and later closeout dispatches", async () => {
    const verify = async (fixture: ReturnType<typeof harness>) => {
      let summary = "";
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      });
      return { code, summary: JSON.parse(summary) as Record<string, unknown> };
    };
    const laterCloseout = mutationRun({
      id: 726,
      workflowPath:
        ".github/workflows/permanent-staging-provider-mutation.yml",
      displayTitle:
        `Permanent staging provider mutation | reconcile-completed-forbidden-offsite-backup-deletion | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:04:01.000Z",
      startedAt: "2026-08-14T01:04:02.000Z",
      updatedAt: "2026-08-14T01:05:00.000Z",
    });
    const rejected = [
      harness({
        anchorParentSha: "e".repeat(40),
      }),
      harness({
        anchorTreeSha: "e".repeat(40),
      }),
      harness({
        comparison: {
          status: "behind",
          ahead_by: 0,
          behind_by: 1,
          base_commit: { sha: CLEANUP_CLOSEOUT_ANCHOR },
          merge_base_commit: { sha: CLEANUP_CLOSEOUT_ANCHOR },
        },
      }),
      harness({
        comparison: {
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          base_commit: { sha: "e".repeat(40) },
          merge_base_commit: { sha: CLEANUP_CLOSEOUT_ANCHOR },
        },
      }),
      harness({
        comparison: {
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          base_commit: { sha: CLEANUP_CLOSEOUT_ANCHOR },
          merge_base_commit: { sha: "e".repeat(40) },
        },
      }),
      harness({
        comparison: {
          status: "ahead",
          ahead_by: 1,
          behind_by: 1,
          base_commit: { sha: CLEANUP_CLOSEOUT_ANCHOR },
          merge_base_commit: { sha: CLEANUP_CLOSEOUT_ANCHOR },
        },
      }),
      harness({
        comparison: {
          status: "ahead",
          ahead_by: 0,
          behind_by: 0,
          base_commit: { sha: CLEANUP_CLOSEOUT_ANCHOR },
          merge_base_commit: { sha: CLEANUP_CLOSEOUT_ANCHOR },
        },
      }),
      harness({
        comparison: {
          status: "ahead",
          ahead_by: 1.5,
          behind_by: 0,
          base_commit: { sha: CLEANUP_CLOSEOUT_ANCHOR },
          merge_base_commit: { sha: CLEANUP_CLOSEOUT_ANCHOR },
        },
      }),
      harness({
        providerMutationRuns: [laterCloseout],
        mutationJobs: {
          726: cleanupSuccessorCloseoutJobs(laterCloseout),
        },
      }),
    ];
    for (const fixture of rejected) {
      await expect(verify(fixture)).resolves.toMatchObject({
        code: 1,
        summary: { failureCode: "staging_mutation_history_invalid" },
      });
    }

    await expect(verify(harness({ comparisonUnavailable: true }))).resolves
      .toMatchObject({
        code: 1,
        summary: { failureCode: "staging_mutation_history_unavailable" },
      });
  });

  it("pins the canonical secret-free cleanup closeout witness in the repository", () => {
    const directory = path.resolve(
      "docs/incident-evidence/permanent-staging-cleanup-closeout-2026-08-29",
    );
    const attestationSource = fs.readFileSync(
      path.join(directory, "attestation.json"),
      "utf8",
    );
    expect(crypto.createHash("sha256").update(attestationSource).digest("hex"))
      .toBe("2f7f0204e4962f33d87d59b09da5a81ee76d343b8d23a48947547ed1099f0a64");
    const attestation = JSON.parse(attestationSource) as {
      retainedEvidence: Array<{
        path: string;
        sha256: string;
        sizeInBytes: number;
      }>;
    };
    for (const evidence of attestation.retainedEvidence) {
      const source = fs.readFileSync(path.resolve(evidence.path));
      expect(source.length).toBe(evidence.sizeInBytes);
      expect(crypto.createHash("sha256").update(source).digest("hex"))
        .toBe(evidence.sha256);
    }
  });

  it("fails closed if a pinned evidence pathname is replaced or linked", () => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "held-pinned-evidence-test-")),
    );
    temporaryDirectories.push(directory);
    const evidencePath = path.join(directory, "evidence.json");
    const displacedPath = path.join(directory, "evidence-held.json");
    const replacementPath = path.join(directory, "replacement.json");
    const trusted = Buffer.from('{"trusted":true}\n');
    fs.writeFileSync(evidencePath, trusted);
    fs.writeFileSync(replacementPath, '{"trusted":false}\n');
    const originalFstatSync = fs.fstatSync;
    let injected = false;
    const fstatSpy = vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
      const value = Reflect.apply(originalFstatSync, fs, args);
      if (!injected) {
        injected = true;
        fs.renameSync(evidencePath, displacedPath);
        fs.renameSync(replacementPath, evidencePath);
      }
      return value;
    });
    try {
      expect(() => readHeldPinnedEvidenceFile(evidencePath, 1024)).toThrow(
        "invalid",
      );
      expect(injected).toBe(true);
      expect(fs.readFileSync(evidencePath, "utf8")).toBe(
        '{"trusted":false}\n',
      );
    } finally {
      fstatSpy.mockRestore();
    }
    const targetPath = path.join(directory, "target.json");
    const symbolicLinkPath = path.join(directory, "evidence-link.json");
    fs.writeFileSync(targetPath, trusted);
    fs.symlinkSync(targetPath, symbolicLinkPath);
    expect(() => readHeldPinnedEvidenceFile(symbolicLinkPath, 1024)).toThrow();
  });

  it("rejects incident-era cancellation operations after the immutable closeout", async () => {
    const terminal = mutationRun({
      id: 741,
      workflowPath:
        ".github/workflows/permanent-staging-provider-mutation.yml",
      displayTitle:
        `Permanent staging provider mutation | cancel-masked-forbidden-offsite-backup-deletion-patch | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:05:20.000Z",
      startedAt: "2026-08-14T01:05:20.000Z",
      updatedAt: "2026-08-14T01:06:00.000Z",
    });
    const fixture = harness({
      providerMutationRuns: [terminal],
      mutationJobs: { 741: providerMutationJobs(terminal, "success") },
    });
    let summary = "";
    await expect(runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: (value: string) => { summary += value; },
    })).resolves.toBe(1);
    expect(JSON.parse(summary)).toMatchObject({
      failureCode: "staging_mutation_history_invalid",
    });
  });

  it("rejects a descendant candidate whose claimed merge predates the closeout", async () => {
    const fixture = harness({ mergedAt: "2026-08-29T11:22:42Z" });
    let summary = "";
    await expect(runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: (value: string) => { summary += value; },
    })).resolves.toBe(1);
    expect(JSON.parse(summary)).toMatchObject({
      failureCode: "staging_mutation_history_invalid",
    });
  });

  it("requires the complete candidate-bound staging worker bootstrap history", async () => {
    for (const fixture of [
      harness({ workerFenceRuns: [] }),
      harness({ stagingBootstrapRuns: [] }),
    ]) {
      let summary = "";
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      });
      expect(code).toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "staging_bootstrap_history_invalid",
      });
    }
  });

  it("requires exactly one successful venue-directory run bound between fenced deploy and restore", async () => {
    const venue = (overrides: Partial<Parameters<typeof mutationRun>[0]> = {}) =>
      mutationRun({
        id: 109,
        workflowPath:
          ".github/workflows/permanent-staging-venue-directory.yml",
        displayTitle:
          `Permanent staging venue directory | apply-refresh-validate | ${CANDIDATE}`,
        createdAt: "2026-08-14T01:08:30.000Z",
        startedAt: "2026-08-14T01:08:30.050Z",
        updatedAt: "2026-08-14T01:08:30.450Z",
        ...overrides,
      });
    const rejected = [
      harness({ venueDirectoryRuns: [] }),
      harness({ venueDirectoryRuns: [venue(), venue({ id: 910 })] }),
      harness({ venueDirectoryRuns: [venue({ conclusion: "failure" })] }),
      harness({
        venueDirectoryRuns: [venue({
          displayTitle:
            `Permanent staging venue directory | unexpected | ${CANDIDATE}`,
        })],
      }),
      harness({
        venueDirectoryRuns: [venue({
          startedAt: "2026-08-14T01:08:30.200Z",
        })],
      }),
    ];
    for (const fixture of rejected) {
      let summary = "";
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      });
      expect(code).toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "staging_bootstrap_history_invalid",
      });
    }
  });

  it("accepts the exact cold prepare-to-quiesce staging bootstrap chain", async () => {
    const fixture = harness({ stagingBootstrapPath: "cold" });
    const code = await runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: () => undefined,
    });
    expect(code).toBe(0);
    expect(fixture.fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(
        "/actions/workflows/recover-permanent-staging-cold-zero.yml/runs?",
      ),
      expect.anything(),
    );
  });

  it("accepts only authenticated pre-write-skipped cold retries", async () => {
    const skippedPrepare = coldRecoveryRun("prepare", {
      id: 708,
      conclusion: "failure",
      createdAt: "2026-08-14T01:00:01.000Z",
      startedAt: "2026-08-14T01:00:05.000Z",
      updatedAt: "2026-08-14T01:00:20.000Z",
    });
    const skippedQuiesce = coldRecoveryRun("quiesce", {
      id: 709,
      conclusion: "cancelled",
      createdAt: "2026-08-14T01:02:01.000Z",
      startedAt: "2026-08-14T01:02:02.000Z",
      updatedAt: "2026-08-14T01:02:05.000Z",
    });
    const fixture = harness({
      stagingBootstrapPath: "cold",
      coldRecoveryRuns: [
        skippedPrepare,
        coldRecoveryRun("prepare"),
        skippedQuiesce,
        coldRecoveryRun("quiesce"),
      ],
      mutationJobs: {
        708: coldRecoveryJobs(skippedPrepare, "prepare", "skipped"),
        709: coldRecoveryJobs(skippedQuiesce, "quiesce", "skipped"),
      },
    });
    await expect(runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: () => undefined,
    })).resolves.toBe(0);
  });

  it("accepts one ambiguous cold quiesce only through one read-only reconciliation", async () => {
    const ambiguousQuiesce = coldRecoveryRun("quiesce", {
      conclusion: "failure",
    });
    const reconciledQuiesce = coldRecoveryRun("reconcile-quiesce");
    const fixture = harness({
      stagingBootstrapPath: "cold",
      coldRecoveryRuns: [
        coldRecoveryRun("prepare"),
        ambiguousQuiesce,
        reconciledQuiesce,
      ],
      mutationJobs: {
        711: coldRecoveryJobs(ambiguousQuiesce, "quiesce", "failure"),
        714: coldRecoveryJobs(
          reconciledQuiesce,
          "reconcile-quiesce",
          "success",
        ),
      },
    });
    await expect(runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: () => undefined,
    })).resolves.toBe(0);
  });

  it("accepts the exact read-only recovery chain for lost prepare, restore, and activation acknowledgements", async () => {
    const ambiguousPrepare = coldRecoveryRun("prepare", {
      conclusion: "failure",
    });
    const priorPrepareReconcile = coldRecoveryRun("reconcile-prepare", {
      id: 728,
      conclusion: "failure",
      createdAt: "2026-08-14T01:02:00.100Z",
      startedAt: "2026-08-14T01:02:00.200Z",
      updatedAt: "2026-08-14T01:02:01.000Z",
    });
    const reconciledPrepare = coldRecoveryRun("reconcile-prepare");
    const ambiguousQuiesce = coldRecoveryRun("quiesce", {
      conclusion: "cancelled",
    });
    const priorQuiesceReconcile = coldRecoveryRun("reconcile-quiesce", {
      id: 729,
      conclusion: "timed_out",
      createdAt: "2026-08-14T01:03:00.100Z",
      startedAt: "2026-08-14T01:03:00.200Z",
      updatedAt: "2026-08-14T01:03:01.000Z",
    });
    const reconciledQuiesce = coldRecoveryRun("reconcile-quiesce");
    const ambiguousRestore = stagingBootstrapRun("restore", {
      id: 712,
      conclusion: "failure",
      createdAt: "2026-08-14T01:08:30.500Z",
      startedAt: "2026-08-14T01:08:31.000Z",
      updatedAt: "2026-08-14T01:08:32.000Z",
    });
    const reconciledRestore = stagingBootstrapRun("reconcile-restore", {
      id: 716,
      createdAt: "2026-08-14T01:08:32.100Z",
      startedAt: "2026-08-14T01:08:32.200Z",
      updatedAt: "2026-08-14T01:08:32.700Z",
    });
    const priorRestoreReconcile = stagingBootstrapRun("reconcile-restore", {
      id: 732,
      conclusion: "cancelled",
      createdAt: "2026-08-14T01:08:32.010Z",
      startedAt: "2026-08-14T01:08:32.020Z",
      updatedAt: "2026-08-14T01:08:32.100Z",
    });
    const ambiguousActivation = stagingWorkerRun("activate", {
      id: 713,
      conclusion: "timed_out",
      createdAt: "2026-08-14T01:08:32.800Z",
      startedAt: "2026-08-14T01:08:33.000Z",
      updatedAt: "2026-08-14T01:08:34.000Z",
    });
    const reconciledActivation = stagingWorkerRun("reconcile-activate", {
      id: 717,
      createdAt: "2026-08-14T01:08:34.100Z",
      startedAt: "2026-08-14T01:08:34.200Z",
      updatedAt: "2026-08-14T01:08:34.800Z",
    });
    const priorActivationReconcile = stagingWorkerRun("reconcile-activate", {
      id: 733,
      conclusion: "failure",
      createdAt: "2026-08-14T01:08:34.010Z",
      startedAt: "2026-08-14T01:08:34.020Z",
      updatedAt: "2026-08-14T01:08:34.100Z",
    });
    const fixture = harness({
      stagingBootstrapPath: "cold",
      mergedAt: "2026-09-01T01:00:00.000Z",
      coldRecoveryRuns: [
        ambiguousPrepare,
        priorPrepareReconcile,
        reconciledPrepare,
        ambiguousQuiesce,
        priorQuiesceReconcile,
        reconciledQuiesce,
      ],
      stagingBootstrapRuns: [
        ambiguousRestore,
        priorRestoreReconcile,
        reconciledRestore,
      ],
      workerFenceRuns: [
        ambiguousActivation,
        priorActivationReconcile,
        reconciledActivation,
      ],
      mutationJobs: {
        710: coldRecoveryJobs(ambiguousPrepare, "prepare", "failure"),
        728: coldRecoveryJobs(
          priorPrepareReconcile,
          "reconcile-prepare",
          "skipped",
        ),
        715: coldRecoveryJobs(
          reconciledPrepare,
          "reconcile-prepare",
          "success",
        ),
        711: coldRecoveryJobs(ambiguousQuiesce, "quiesce", "cancelled"),
        729: coldRecoveryJobs(
          priorQuiesceReconcile,
          "reconcile-quiesce",
          "skipped",
        ),
        714: coldRecoveryJobs(
          reconciledQuiesce,
          "reconcile-quiesce",
          "success",
        ),
        712: twoJobDisposition(
          ambiguousRestore,
          BOOTSTRAP_JOB_FIXTURES,
          BOOTSTRAP_JOB_FIXTURES[0].jobName,
          "failure",
        ),
        732: twoJobDisposition(
          priorRestoreReconcile,
          BOOTSTRAP_JOB_FIXTURES,
          BOOTSTRAP_JOB_FIXTURES[1].jobName,
          "skipped",
        ),
        716: twoJobDisposition(
          reconciledRestore,
          BOOTSTRAP_JOB_FIXTURES,
          BOOTSTRAP_JOB_FIXTURES[1].jobName,
          "success",
        ),
        713: twoJobDisposition(
          ambiguousActivation,
          WORKER_JOB_FIXTURES,
          WORKER_JOB_FIXTURES[0].jobName,
          "timed_out",
        ),
        733: twoJobDisposition(
          priorActivationReconcile,
          WORKER_JOB_FIXTURES,
          WORKER_JOB_FIXTURES[1].jobName,
          "skipped",
        ),
        717: twoJobDisposition(
          reconciledActivation,
          WORKER_JOB_FIXTURES,
          WORKER_JOB_FIXTURES[1].jobName,
          "success",
        ),
      },
    });
    await expect(runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: () => undefined,
    })).resolves.toBe(0);
  });

  it("rejects unauthenticated, duplicate, overlapping, post-closeout, or generic ambiguous staging writes", async () => {
    const prepare = stagingWorkerRun("prepare", {
      id: 710,
      createdAt: "2026-08-14T01:01:00.000Z",
      startedAt: "2026-08-14T01:01:10.000Z",
      updatedAt: "2026-08-14T01:02:00.000Z",
    });
    const ambiguousActivation = stagingWorkerRun("activate", {
      id: 713,
      conclusion: "failure",
      createdAt: "2026-08-14T01:08:32.800Z",
      startedAt: "2026-08-14T01:08:33.000Z",
      updatedAt: "2026-08-14T01:08:34.000Z",
    });
    const reconciledActivation = stagingWorkerRun("reconcile-activate", {
      id: 717,
      createdAt: "2026-08-14T01:08:34.100Z",
      startedAt: "2026-08-14T01:08:34.200Z",
      updatedAt: "2026-08-14T01:08:34.800Z",
    });
    const activationFailureJobs = twoJobDisposition(
      ambiguousActivation,
      WORKER_JOB_FIXTURES,
      WORKER_JOB_FIXTURES[0].jobName,
      "failure",
    );
    const activationReconcileJobs = twoJobDisposition(
      reconciledActivation,
      WORKER_JOB_FIXTURES,
      WORKER_JOB_FIXTURES[1].jobName,
      "success",
    );
    const duplicateReconcile = stagingWorkerRun("reconcile-activate", {
      id: 718,
      createdAt: "2026-08-14T01:08:35.000Z",
      startedAt: "2026-08-14T01:08:35.100Z",
      updatedAt: "2026-08-14T01:08:35.500Z",
    });
    const overlappingReconcile = stagingWorkerRun("reconcile-activate", {
      id: 719,
      createdAt: "2026-08-14T01:08:33.100Z",
      startedAt: "2026-08-14T01:08:33.200Z",
      updatedAt: "2026-08-14T01:08:34.800Z",
    });
    const overlappingPriorReadOnlyRetry = stagingWorkerRun(
      "reconcile-activate",
      {
        id: 734,
        conclusion: "cancelled",
        createdAt: "2026-08-14T01:08:33.100Z",
        startedAt: "2026-08-14T01:08:33.200Z",
        updatedAt: "2026-08-14T01:08:33.800Z",
      },
    );
    const postCloseoutReconcile = stagingWorkerRun("reconcile-activate", {
      id: 725,
      createdAt: "2026-08-14T01:08:40.100Z",
      startedAt: "2026-08-14T01:08:40.200Z",
      updatedAt: "2026-08-14T01:08:40.800Z",
    });
    const ambiguousPrepare = stagingWorkerRun("prepare", {
      id: 726,
      conclusion: "failure",
      createdAt: "2026-08-14T01:01:00.000Z",
      startedAt: "2026-08-14T01:01:10.000Z",
      updatedAt: "2026-08-14T01:02:00.000Z",
    });
    const normalActivation = stagingWorkerRun("activate", {
      id: 713,
      createdAt: "2026-08-14T01:08:32.800Z",
      startedAt: "2026-08-14T01:08:33.000Z",
      updatedAt: "2026-08-14T01:08:34.000Z",
    });
    const quiesce = stagingBootstrapRun("quiesce", {
      id: 711,
      createdAt: "2026-08-14T01:02:05.000Z",
      startedAt: "2026-08-14T01:02:10.000Z",
      updatedAt: "2026-08-14T01:03:00.000Z",
    });
    const ambiguousRestore = stagingBootstrapRun("restore", {
      id: 712,
      conclusion: "failure",
      createdAt: "2026-08-14T01:08:30.500Z",
      startedAt: "2026-08-14T01:08:31.000Z",
      updatedAt: "2026-08-14T01:08:32.000Z",
    });
    const overlappingRestoreReconcile = stagingBootstrapRun(
      "reconcile-restore",
      {
        id: 727,
        createdAt: "2026-08-14T01:08:31.100Z",
        startedAt: "2026-08-14T01:08:31.200Z",
        updatedAt: "2026-08-14T01:08:32.700Z",
      },
    );
    const fixtures = [
      harness({
        workerFenceRuns: [prepare, ambiguousActivation, reconciledActivation],
        mutationJobs: {
          713: activationFailureJobs,
          717: { total_count: 0, jobs: [] },
        },
      }),
      harness({
        workerFenceRuns: [
          prepare,
          ambiguousActivation,
          reconciledActivation,
          duplicateReconcile,
        ],
        mutationJobs: {
          713: activationFailureJobs,
          717: activationReconcileJobs,
          718: twoJobDisposition(
            duplicateReconcile,
            WORKER_JOB_FIXTURES,
            WORKER_JOB_FIXTURES[1].jobName,
            "success",
          ),
        },
      }),
      harness({
        workerFenceRuns: [prepare, ambiguousActivation, overlappingReconcile],
        mutationJobs: {
          713: activationFailureJobs,
          719: twoJobDisposition(
            overlappingReconcile,
            WORKER_JOB_FIXTURES,
            WORKER_JOB_FIXTURES[1].jobName,
            "success",
          ),
        },
      }),
      harness({
        workerFenceRuns: [
          prepare,
          ambiguousActivation,
          overlappingPriorReadOnlyRetry,
          reconciledActivation,
        ],
        mutationJobs: {
          713: activationFailureJobs,
          734: twoJobDisposition(
            overlappingPriorReadOnlyRetry,
            WORKER_JOB_FIXTURES,
            WORKER_JOB_FIXTURES[1].jobName,
            "skipped",
          ),
          717: activationReconcileJobs,
        },
      }),
      harness({
        workerFenceRuns: [prepare, ambiguousActivation, postCloseoutReconcile],
        mutationJobs: {
          713: activationFailureJobs,
          725: twoJobDisposition(
            postCloseoutReconcile,
            WORKER_JOB_FIXTURES,
            WORKER_JOB_FIXTURES[1].jobName,
            "success",
          ),
        },
      }),
      harness({
        workerFenceRuns: [ambiguousPrepare, normalActivation],
        mutationJobs: {
          726: twoJobDisposition(
            ambiguousPrepare,
            WORKER_JOB_FIXTURES,
            WORKER_JOB_FIXTURES[0].jobName,
            "failure",
          ),
        },
      }),
      harness({
        stagingBootstrapRuns: [
          quiesce,
          ambiguousRestore,
          overlappingRestoreReconcile,
        ],
        mutationJobs: {
          712: twoJobDisposition(
            ambiguousRestore,
            BOOTSTRAP_JOB_FIXTURES,
            BOOTSTRAP_JOB_FIXTURES[0].jobName,
            "failure",
          ),
          727: twoJobDisposition(
            overlappingRestoreReconcile,
            BOOTSTRAP_JOB_FIXTURES,
            BOOTSTRAP_JOB_FIXTURES[1].jobName,
            "success",
          ),
        },
      }),
    ];
    for (const fixture of fixtures) {
      let summary = "";
      await expect(runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      })).resolves.toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        failureCode: "staging_bootstrap_history_invalid",
      });
    }
  });

  it("measures runner-loss grace from the original ambiguous write completion", async () => {
    const originalPrepare = coldRecoveryRun("prepare", {
      conclusion: "failure",
      createdAt: "2026-08-30T01:01:00.000Z",
      startedAt: "2026-08-30T01:01:10.000Z",
      updatedAt: "2026-08-30T01:02:00.000Z",
    });
    const lateReconcile = coldRecoveryRun("reconcile-prepare");
    const fixture = harness({
      stagingBootstrapPath: "cold",
      mergedAt: "2026-08-30T01:00:00.000Z",
      coldRecoveryRuns: [
        originalPrepare,
        lateReconcile,
        coldRecoveryRun("quiesce"),
      ],
      mutationJobs: {
        710: coldRecoveryJobs(originalPrepare, "prepare", "failure"),
        715: coldRecoveryJobs(
          lateReconcile,
          "reconcile-prepare",
          "success",
        ),
      },
    });
    let summary = "";
    await expect(runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: (value: string) => { summary += value; },
    })).resolves.toBe(1);
    expect(JSON.parse(summary)).toMatchObject({
      failureCode: "staging_mutation_history_expired",
    });
  });

  it("rejects ambiguous or repeated cold reconciliation histories", async () => {
    const ambiguousQuiesce = coldRecoveryRun("quiesce", {
      conclusion: "failure",
    });
    const secondAmbiguousQuiesce = coldRecoveryRun("quiesce", {
      id: 715,
      conclusion: "timed_out",
      createdAt: "2026-08-14T01:03:01.000Z",
      startedAt: "2026-08-14T01:03:02.000Z",
      updatedAt: "2026-08-14T01:03:04.000Z",
    });
    const mayHaveWrittenPrepare = coldRecoveryRun("prepare", {
      id: 708,
      conclusion: "failure",
      createdAt: "2026-08-14T01:00:01.000Z",
      startedAt: "2026-08-14T01:00:05.000Z",
      updatedAt: "2026-08-14T01:00:20.000Z",
    });
    const fixtures = [
      harness({
        stagingBootstrapPath: "cold",
        coldRecoveryRuns: [coldRecoveryRun("prepare"), ambiguousQuiesce],
        mutationJobs: {
          711: coldRecoveryJobs(ambiguousQuiesce, "quiesce", "failure"),
        },
      }),
      harness({
        stagingBootstrapPath: "cold",
        coldRecoveryRuns: [
          coldRecoveryRun("prepare"),
          ambiguousQuiesce,
          coldRecoveryRun("reconcile-quiesce"),
        ],
      }),
      harness({
        stagingBootstrapPath: "cold",
        coldRecoveryRuns: [
          coldRecoveryRun("prepare"),
          ambiguousQuiesce,
          secondAmbiguousQuiesce,
          coldRecoveryRun("reconcile-quiesce"),
        ],
        mutationJobs: {
          711: coldRecoveryJobs(ambiguousQuiesce, "quiesce", "failure"),
          715: coldRecoveryJobs(
            secondAmbiguousQuiesce,
            "quiesce",
            "timed_out",
          ),
        },
      }),
      harness({
        stagingBootstrapPath: "cold",
        coldRecoveryRuns: [
          mayHaveWrittenPrepare,
          coldRecoveryRun("prepare"),
          coldRecoveryRun("quiesce"),
        ],
        mutationJobs: {
          708: coldRecoveryJobs(
            mayHaveWrittenPrepare,
            "prepare",
            "failure",
          ),
        },
      }),
      harness({
        stagingBootstrapPath: "cold",
        coldRecoveryRuns: [
          coldRecoveryRun("prepare"),
          ambiguousQuiesce,
          coldRecoveryRun("reconcile-quiesce"),
          coldRecoveryRun("reconcile-quiesce", { id: 716 }),
        ],
        mutationJobs: {
          711: coldRecoveryJobs(ambiguousQuiesce, "quiesce", "failure"),
        },
      }),
    ];
    for (const fixture of fixtures) {
      let summary = "";
      await expect(runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      })).resolves.toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "staging_bootstrap_history_invalid",
      });
    }
  });

  it("rejects mixed, extra, failed, missing, or ambiguous cold histories", async () => {
    const fixtures = [
      harness({
        coldRecoveryRuns: [
          coldRecoveryRun("prepare"),
          coldRecoveryRun("quiesce"),
        ],
      }),
      harness({
        stagingBootstrapPath: "cold",
        coldRecoveryRuns: [
          coldRecoveryRun("prepare"),
          coldRecoveryRun("quiesce"),
          coldRecoveryRun("prepare", { id: 714 }),
        ],
      }),
      harness({
        stagingBootstrapPath: "cold",
        coldRecoveryRuns: [
          coldRecoveryRun("prepare", { conclusion: "failure" }),
          coldRecoveryRun("quiesce"),
        ],
      }),
      harness({
        stagingBootstrapPath: "cold",
        coldRecoveryRuns: [coldRecoveryRun("prepare")],
      }),
      harness({
        stagingBootstrapPath: "cold",
        coldRecoveryRuns: [
          coldRecoveryRun("prepare", { id: 710 }),
          coldRecoveryRun("quiesce", { id: 710 }),
        ],
      }),
    ];
    for (const fixture of fixtures) {
      let summary = "";
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      });
      expect(code).toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "staging_bootstrap_history_invalid",
      });
    }
  });

  it("rejects a merge without exact GitHub PR, linear-history, tree, and identity binding", async () => {
    for (const fixture of [
      harness({ associatedPullCount: 0 }),
      harness({ pullMergeCommitSha: "e".repeat(40) }),
      harness({ pullMerged: false }),
      harness({ pullDraft: true }),
      harness({ pullBaseRef: "develop" }),
      harness({ pullBaseRepository: "other/Beer" }),
      harness({ pullHeadRepository: "fork/Beer" }),
      harness({ pullHeadSha: "invalid" }),
      harness({ pullAuthorId: 0 }),
      harness({ pullMergedById: 0 }),
      harness({ candidateParentCount: 2 }),
      harness({ reviewedTreeSha: "e".repeat(40) }),
    ]) {
      let summary = "";
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      });
      expect(code).toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "reviewed_pull_request_invalid",
      });
    }
  });

  it("accepts a merged solo-owner PR without querying reviews or collaborators", async () => {
    const fixture = harness();
    const code = await runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: () => undefined,
    });
    expect(code).toBe(0);
    const requestedUrls = fixture.fetchImpl.mock.calls.map(([url]) => String(url));
    expect(requestedUrls.some((url) => url.includes("/reviews"))).toBe(false);
    expect(requestedUrls.some((url) => url.includes("/collaborators/"))).toBe(false);
  });

  it("selects only the check from the policy-bound workflow and event", async () => {
    const fixture = harness({
      phase: "staging",
      additionalWrongIdentityCheck: "ios",
    });
    const code = await runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: () => undefined,
    });
    expect(code).toBe(0);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(fixture.directory, "receipt.json"), "utf8"),
    );
    expect(
      receipt.checks.filter((check: { name: string }) => check.name === "ios"),
    ).toEqual([
      expect.objectContaining({
        workflowPath: ".github/workflows/native-apps.yml",
        event: "push",
      }),
    ]);
  });

  it("fails closed for missing, duplicated, spoofed, or misbound checks and missing artifacts", async () => {
    for (const fixture of [
      harness({ omitCheck: "build-test-scan" }),
      harness({ duplicateCheck: "build-test-scan" }),
      harness({ wrongEventOnlyCheck: "ios" }),
      harness({ wrongWorkflowOnlyCheck: "ios" }),
      harness({ untrustedDuplicateCheck: "ios" }),
      harness({ omitArtifact: `pintpath-production-deployment-${CANDIDATE}` }),
    ]) {
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: () => undefined,
      });
      expect(code).toBe(1);
      expect(fs.existsSync(path.join(fixture.directory, "receipt.json"))).toBe(
        false,
      );
    }
  });

  it("fails closed if the validated output parent is replaced during exclusive creation", async () => {
    const fixture = harness({ phase: "staging" });
    const displaced = `${fixture.directory}-held`;
    temporaryDirectories.push(displaced);
    const originalOpenSync = fs.openSync;
    let injected = false;
    let creationTarget = "";
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      const [target, flags] = args;
      if (
        !injected && typeof flags === "number" &&
        (flags & fs.constants.O_CREAT) !== 0 &&
        path.basename(String(target)) === "receipt.json"
      ) {
        injected = true;
        creationTarget = String(target);
        fs.renameSync(fixture.directory, displaced);
        fs.mkdirSync(fixture.directory, { mode: 0o700 });
      }
      return Reflect.apply(originalOpenSync, fs, args);
    });
    let summary = "";
    try {
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      });
      expect(injected).toBe(true);
      if (process.platform === "linux") {
        expect(creationTarget).toMatch(/^\/proc\/self\/fd\/[1-9][0-9]*\/receipt\.json$/);
        expect(fs.existsSync(path.join(fixture.directory, "receipt.json"))).toBe(false);
      }
      expect(code).toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "output_unsafe",
      });
    } finally {
      openSpy.mockRestore();
    }
  });

  it("fails closed if the output leaf is replaced during parent durability sync", async () => {
    const fixture = harness({ phase: "staging" });
    const receipt = path.join(fixture.directory, "receipt.json");
    const displaced = path.join(fixture.directory, "receipt-held.json");
    const originalFsyncSync = fs.fsyncSync;
    let fsyncCalls = 0;
    const fsyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      fsyncCalls += 1;
      if (fsyncCalls === 2) {
        fs.renameSync(receipt, displaced);
        fs.writeFileSync(receipt, "forged", { flag: "wx", mode: 0o600 });
      }
      return originalFsyncSync(fd);
    });
    let summary = "";
    try {
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      });
      expect(fsyncCalls).toBe(2);
      expect(code).toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "output_unsafe",
      });
    } finally {
      fsyncSpy.mockRestore();
    }
  });

  it("rejects an out-of-order rollout, a rerun predecessor, or the wrong current consumer", async () => {
    for (const fixture of [
      harness({ phase: "open", chronologyOverlapStage: "scale" }),
      harness({ phase: "close", predecessorRunAttempt: 2 }),
      harness({
        phase: "open",
        currentWorkflowPath: ".github/workflows/close-production-route.yml",
      }),
      harness({ phase: "open", currentEvent: "push" }),
      harness({ phase: "open", currentRunAttempt: 2 }),
      harness({ phase: "open", currentRunId: 9_998 }),
    ]) {
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: () => undefined,
      });
      expect(code).toBe(1);
      expect(fs.existsSync(path.join(fixture.directory, "receipt.json"))).toBe(false);
    }
  });

  it("rejects local, stale-ref, or wrong-candidate GitHub contexts before querying", async () => {
    const fixture = harness({ phase: "staging" });
    const code = await runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "false",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: () => undefined,
    });
    expect(code).toBe(1);
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });
});
