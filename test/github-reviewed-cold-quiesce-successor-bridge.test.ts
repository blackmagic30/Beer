import { describe, expect, it, vi } from "vitest";

import {
  verifyColdQuiesceSuccessorBridge,
} from "../scripts/verify-github-reviewed-candidate-authority.mjs";

const REPOSITORY = "blackmagic30/Beer";
const COLD_RECOVERY_PATH =
  ".github/workflows/recover-permanent-staging-cold-zero.yml";
const PRIOR_CANDIDATE = "838e8c877dcafc0a822a12e5a26afa81c26924a3";
const PRIOR_REVIEWED_HEAD =
  "cc2c5311d47f3e895173cb11ef094ef856e0cf07";
const PRIOR_TREE = "9da75485e85addfec7096b1c04c52f6780d17b64";
const INTERMEDIATE_CANDIDATE =
  "919cbbc9ed4a5bb1d99bc2624f5b534e31ddb604";
const INTERMEDIATE_REVIEWED_HEAD =
  "a8448524162c36da3d220c4b8aa21dd42cb11535";
const INTERMEDIATE_TREE =
  "06257eba9476e393fe54b70395af8641f8b6d59a";
const IMMEDIATE_PRIOR_CANDIDATE =
  "1161e7ecd421556b104bcae059e8764ebf4a545e";
const IMMEDIATE_PRIOR_REVIEWED_HEAD =
  "23f6b96154de7a0eb5a0cc90136d3796a1301668";
const IMMEDIATE_PRIOR_TREE =
  "8a58c3eb755a68a2c456a5abff34fa7c01a9af3e";
const FAILED_PREWRITE_CANDIDATE =
  "de35797a41640a996971af0b1ad49e3c5372baa8";
const FAILED_PREWRITE_REVIEWED_HEAD =
  "546b32711971666c9074d6c6bd0d2556f76f4bb6";
const FAILED_PREWRITE_TREE =
  "efe8319526c25f28b6bcb8cc44bd559d0eed98e7";
const CURRENT_CANDIDATE = "a".repeat(40);
const CURRENT_TREE = "b".repeat(40);
const PREPARE_RUN_ID = 34152745186;
const AMBIGUOUS_QUIESCE_RUN_ID = 34153306935;
const READ_ONLY_RECONCILE_RUN_ID = 34154020478;
const INTERMEDIATE_AMBIGUOUS_PREPARE_RUN_ID = 34180322982;
const INTERMEDIATE_READ_ONLY_PREPARE_RECONCILE_RUN_ID = 34181145015;
const IMMEDIATE_PRIOR_PREPARE_RUN_ID = 34186355641;
const IMMEDIATE_PRIOR_QUIESCE_RUN_ID = 34186930666;
const FAILED_PREWRITE_PREPARE_RUN_ID = 34221196430;
const FAILED_PREWRITE_QUIESCE_RUN_ID = 34221811602;
const CURRENT_PREPARE_RUN_ID = 34190000001;
const CURRENT_RUN_ID = 34190000002;
const ARTIFACT_ID = 10030213299;
const ARTIFACT_NAME =
  `pintpath-permanent-staging-cold-quiesce-${PRIOR_CANDIDATE}`;
const ARTIFACT_DIGEST =
  "sha256:3f830a7376e604a46e0d8cfe3521fc8eb4e1db444ab73bec4063c22442c42fbe";
const IMMEDIATE_PRIOR_ARTIFACT_ID = 10040956324;
const IMMEDIATE_PRIOR_ARTIFACT_NAME =
  `pintpath-permanent-staging-cold-quiesce-${IMMEDIATE_PRIOR_CANDIDATE}`;
const IMMEDIATE_PRIOR_ARTIFACT_DIGEST =
  "sha256:3db418b86eea098ff4cf8c3a5198ac445d5a51c2f0ac7481dce288027c70166e";
const FAILED_PREWRITE_ARTIFACT_ID = 10054211585;
const FAILED_PREWRITE_ARTIFACT_NAME =
  `pintpath-permanent-staging-cold-quiesce-${FAILED_PREWRITE_CANDIDATE}`;
const FAILED_PREWRITE_ARTIFACT_DIGEST =
  "sha256:bbc8716da1caf68cc39307ac0cb2a07f1066b6cbb5d8159fbf56e0fe552e4ee0";
const CURRENT_MERGED_AT = "2026-09-08T12:00:00Z";
const CURRENT_RUN_STARTED_AT = "2026-09-08T12:10:00Z";

const CURRENT_QUIESCE_JOB_NAME =
  "Quiesce the configured Europe replica from one to zero";
const CURRENT_QUIESCE_WRITE_STEP =
  "Quiesce the configured Europe replica from one to zero once";
const LEGACY_QUIESCE_JOB_NAME =
  "Initialize the exact dead baseline at explicit zero";
const LEGACY_QUIESCE_WRITE_STEP =
  "Initialize the dead baseline from null to explicit zero once";
const CURRENT_COLD_JOB_NAMES = [
  "Bind the exact replacement and prepare the dead baseline",
  "Reconcile an ambiguous cold prepare at the exact dead baseline",
  CURRENT_QUIESCE_JOB_NAME,
  "Reconcile an ambiguous cold quiesce at exact zero",
] as const;
const LEGACY_COLD_JOB_NAMES = [
  "Bind the exact replacement and prepare the dead baseline",
  "Reconcile an ambiguous cold prepare at the exact dead baseline",
  LEGACY_QUIESCE_JOB_NAME,
  "Reconcile an ambiguous cold quiesce at exact zero",
] as const;

function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function coldRun(input: {
  id: number;
  operation:
    | "prepare"
    | "reconcile-prepare"
    | "quiesce"
    | "reconcile-quiesce";
  createdAt: string;
  completedAt: string;
  conclusion: "success" | "failure" | null;
  status?: string;
  headSha?: string;
}) {
  const headSha = input.headSha ?? PRIOR_CANDIDATE;
  return {
    id: input.id,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    head_sha: headSha,
    head_branch: "main",
    path: `${COLD_RECOVERY_PATH}@main`,
    event: "workflow_dispatch",
    display_title:
      `Permanent staging cold recovery | ${input.operation} | ${headSha}`,
    run_attempt: 1,
    status: input.status ?? "completed",
    conclusion: input.conclusion,
    created_at: input.createdAt,
    run_started_at: input.createdAt,
    updated_at: input.completedAt,
  };
}

const PREPARE_RUN = coldRun({
  id: PREPARE_RUN_ID,
  operation: "prepare",
  createdAt: "2026-09-07T18:43:02Z",
  completedAt: "2026-09-07T18:47:32Z",
  conclusion: "success",
});
const AMBIGUOUS_QUIESCE_RUN = coldRun({
  id: AMBIGUOUS_QUIESCE_RUN_ID,
  operation: "quiesce",
  createdAt: "2026-09-07T18:51:21Z",
  completedAt: "2026-09-07T18:57:20Z",
  conclusion: "failure",
});
const READ_ONLY_RECONCILE_RUN = coldRun({
  id: READ_ONLY_RECONCILE_RUN_ID,
  operation: "reconcile-quiesce",
  createdAt: "2026-09-07T19:02:23Z",
  completedAt: "2026-09-07T19:06:38Z",
  conclusion: "failure",
});
const INTERMEDIATE_AMBIGUOUS_PREPARE_RUN = coldRun({
  id: INTERMEDIATE_AMBIGUOUS_PREPARE_RUN_ID,
  operation: "prepare",
  createdAt: "2026-09-08T02:31:01Z",
  completedAt: "2026-09-08T02:36:30Z",
  conclusion: "failure",
  headSha: INTERMEDIATE_CANDIDATE,
});
const INTERMEDIATE_READ_ONLY_PREPARE_RECONCILE_RUN = coldRun({
  id: INTERMEDIATE_READ_ONLY_PREPARE_RECONCILE_RUN_ID,
  operation: "reconcile-prepare",
  createdAt: "2026-09-08T02:45:16Z",
  completedAt: "2026-09-08T02:48:59Z",
  conclusion: "failure",
  headSha: INTERMEDIATE_CANDIDATE,
});
const IMMEDIATE_PRIOR_PREPARE_RUN = coldRun({
  id: IMMEDIATE_PRIOR_PREPARE_RUN_ID,
  operation: "prepare",
  createdAt: "2026-09-08T04:15:27Z",
  completedAt: "2026-09-08T04:20:00Z",
  conclusion: "success",
  headSha: IMMEDIATE_PRIOR_CANDIDATE,
});
const IMMEDIATE_PRIOR_QUIESCE_RUN = coldRun({
  id: IMMEDIATE_PRIOR_QUIESCE_RUN_ID,
  operation: "quiesce",
  createdAt: "2026-09-08T04:25:21Z",
  completedAt: "2026-09-08T04:32:27Z",
  conclusion: "failure",
  headSha: IMMEDIATE_PRIOR_CANDIDATE,
});
const FAILED_PREWRITE_PREPARE_RUN = coldRun({
  id: FAILED_PREWRITE_PREPARE_RUN_ID,
  operation: "prepare",
  createdAt: "2026-09-08T11:32:06Z",
  completedAt: "2026-09-08T11:36:40Z",
  conclusion: "success",
  headSha: FAILED_PREWRITE_CANDIDATE,
});
const FAILED_PREWRITE_QUIESCE_RUN = coldRun({
  id: FAILED_PREWRITE_QUIESCE_RUN_ID,
  operation: "quiesce",
  createdAt: "2026-09-08T11:39:07Z",
  completedAt: "2026-09-08T11:44:07Z",
  conclusion: "failure",
  headSha: FAILED_PREWRITE_CANDIDATE,
});
const CURRENT_PREPARE_RUN = coldRun({
  id: CURRENT_PREPARE_RUN_ID,
  operation: "prepare",
  createdAt: "2026-09-08T12:02:00Z",
  completedAt: "2026-09-08T12:07:00Z",
  conclusion: "success",
  headSha: CURRENT_CANDIDATE,
});

function coldJobs(
  runId: number,
  jobNames: readonly string[],
  selectedName: string,
  selectedConclusion: "success" | "failure",
  selectedSteps: Array<Record<string, string>>,
) {
  return {
    total_count: jobNames.length,
    jobs: jobNames.map((name) => name === selectedName
      ? {
          run_id: runId,
          run_attempt: 1,
          name,
          status: "completed",
          conclusion: selectedConclusion,
          steps: selectedSteps,
        }
      : {
          run_id: runId,
          run_attempt: 1,
          name,
          status: "completed",
          conclusion: "skipped",
          steps: [],
        }),
  };
}

function bridgeFixture(options: {
  currentParentSha?: string;
  immediatePriorParentSha?: string;
  failedPrewriteParentSha?: string;
  intermediateParentSha?: string;
  artifactDigest?: string;
  immediatePriorArtifactDigest?: string;
  failedPrewriteArtifactDigest?: string;
  inputPriorCandidateSha?: string;
  inputPriorRunId?: string;
  currentRunStartedAt?: string;
  currentMergedAt?: string;
  currentHistoryUpdatedAt?: string;
  ambiguousUsesCurrentNames?: boolean;
  currentPrepareUsesLegacyNames?: boolean;
  failedPrewriteWriteConclusion?: "skipped" | "success" | "failure" | "cancelled";
  intermediatePrepareWriteConclusion?: "failure" | "skipped";
  intermediateReconcileSiblingConclusion?: "skipped" | "success";
  omitIntermediatePrepare?: boolean;
  omitIntermediateReconcile?: boolean;
  omitImmediatePriorPrepare?: boolean;
  omitImmediatePriorQuiesce?: boolean;
  omitFailedPrewritePrepare?: boolean;
  omitFailedPrewriteQuiesce?: boolean;
  extraRuns?: Array<Record<string, unknown>>;
} = {}) {
  const currentParentSha = options.currentParentSha ?? FAILED_PREWRITE_CANDIDATE;
  const failedPrewriteParentSha = options.failedPrewriteParentSha ??
    IMMEDIATE_PRIOR_CANDIDATE;
  const immediatePriorParentSha = options.immediatePriorParentSha ??
    INTERMEDIATE_CANDIDATE;
  const intermediateParentSha = options.intermediateParentSha ?? PRIOR_CANDIDATE;
  const artifactDigest = options.artifactDigest ?? ARTIFACT_DIGEST;
  const currentRunStartedAt = options.currentRunStartedAt ??
    CURRENT_RUN_STARTED_AT;
  const currentRun = coldRun({
    id: CURRENT_RUN_ID,
    operation: "quiesce",
    createdAt: currentRunStartedAt,
    completedAt: currentRunStartedAt,
    conclusion: null,
    status: "in_progress",
    headSha: CURRENT_CANDIDATE,
  });
  const fetchImpl = vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (url.includes(`/commits/${PRIOR_CANDIDATE}/pulls?`)) {
      return response([{
        number: 90,
        state: "closed",
        merge_commit_sha: PRIOR_CANDIDATE,
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: { repo: { full_name: REPOSITORY } },
      }]);
    }
    if (url.endsWith("/pulls/90")) {
      return response({
        number: 90,
        state: "closed",
        merged: true,
        draft: false,
        merge_commit_sha: PRIOR_CANDIDATE,
        merged_at: "2026-09-07T18:18:58Z",
        user: { id: 101 },
        merged_by: { id: 202 },
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: {
          sha: PRIOR_REVIEWED_HEAD,
          repo: { full_name: REPOSITORY },
        },
      });
    }
    if (url.endsWith(`/git/commits/${PRIOR_CANDIDATE}`)) {
      return response({
        sha: PRIOR_CANDIDATE,
        tree: { sha: PRIOR_TREE },
        parents: [{ sha: "1".repeat(40) }],
      });
    }
    if (url.endsWith(`/git/commits/${PRIOR_REVIEWED_HEAD}`)) {
      return response({
        sha: PRIOR_REVIEWED_HEAD,
        tree: { sha: PRIOR_TREE },
        parents: [{ sha: "2".repeat(40) }],
      });
    }
    if (url.includes(`/commits/${INTERMEDIATE_CANDIDATE}/pulls?`)) {
      return response([{
        number: 91,
        state: "closed",
        merge_commit_sha: INTERMEDIATE_CANDIDATE,
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: { repo: { full_name: REPOSITORY } },
      }]);
    }
    if (url.endsWith("/pulls/91")) {
      return response({
        number: 91,
        state: "closed",
        merged: true,
        draft: false,
        merge_commit_sha: INTERMEDIATE_CANDIDATE,
        merged_at: "2026-09-08T02:22:51Z",
        user: { id: 101 },
        merged_by: { id: 202 },
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: {
          sha: INTERMEDIATE_REVIEWED_HEAD,
          repo: { full_name: REPOSITORY },
        },
      });
    }
    if (url.endsWith(`/git/commits/${INTERMEDIATE_CANDIDATE}`)) {
      return response({
        sha: INTERMEDIATE_CANDIDATE,
        tree: { sha: INTERMEDIATE_TREE },
        parents: [{ sha: intermediateParentSha }],
      });
    }
    if (url.endsWith(`/git/commits/${INTERMEDIATE_REVIEWED_HEAD}`)) {
      return response({
        sha: INTERMEDIATE_REVIEWED_HEAD,
        tree: { sha: INTERMEDIATE_TREE },
        parents: [{ sha: "4".repeat(40) }],
      });
    }
    if (url.includes(`/commits/${IMMEDIATE_PRIOR_CANDIDATE}/pulls?`)) {
      return response([{
        number: 93,
        state: "closed",
        merge_commit_sha: IMMEDIATE_PRIOR_CANDIDATE,
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: { repo: { full_name: REPOSITORY } },
      }]);
    }
    if (url.endsWith("/pulls/93")) {
      return response({
        number: 93,
        state: "closed",
        merged: true,
        draft: false,
        merge_commit_sha: IMMEDIATE_PRIOR_CANDIDATE,
        merged_at: "2026-09-08T04:04:40Z",
        user: { id: 101 },
        merged_by: { id: 202 },
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: {
          sha: IMMEDIATE_PRIOR_REVIEWED_HEAD,
          repo: { full_name: REPOSITORY },
        },
      });
    }
    if (url.endsWith(`/git/commits/${IMMEDIATE_PRIOR_CANDIDATE}`)) {
      return response({
        sha: IMMEDIATE_PRIOR_CANDIDATE,
        tree: { sha: IMMEDIATE_PRIOR_TREE },
        parents: [{ sha: immediatePriorParentSha }],
      });
    }
    if (url.endsWith(`/git/commits/${IMMEDIATE_PRIOR_REVIEWED_HEAD}`)) {
      return response({
        sha: IMMEDIATE_PRIOR_REVIEWED_HEAD,
        tree: { sha: IMMEDIATE_PRIOR_TREE },
        parents: [{ sha: "5".repeat(40) }],
      });
    }
    if (url.includes(`/commits/${FAILED_PREWRITE_CANDIDATE}/pulls?`)) {
      return response([{
        number: 95,
        state: "closed",
        merge_commit_sha: FAILED_PREWRITE_CANDIDATE,
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: { repo: { full_name: REPOSITORY } },
      }]);
    }
    if (url.endsWith("/pulls/95")) {
      return response({
        number: 95,
        state: "closed",
        merged: true,
        draft: false,
        merge_commit_sha: FAILED_PREWRITE_CANDIDATE,
        merged_at: "2026-09-08T11:10:55Z",
        user: { id: 101 },
        merged_by: { id: 202 },
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: {
          sha: FAILED_PREWRITE_REVIEWED_HEAD,
          repo: { full_name: REPOSITORY },
        },
      });
    }
    if (url.endsWith(`/git/commits/${FAILED_PREWRITE_CANDIDATE}`)) {
      return response({
        sha: FAILED_PREWRITE_CANDIDATE,
        tree: { sha: FAILED_PREWRITE_TREE },
        parents: [{ sha: failedPrewriteParentSha }],
      });
    }
    if (url.endsWith(`/git/commits/${FAILED_PREWRITE_REVIEWED_HEAD}`)) {
      return response({
        sha: FAILED_PREWRITE_REVIEWED_HEAD,
        tree: { sha: FAILED_PREWRITE_TREE },
        parents: [{ sha: "6".repeat(40) }],
      });
    }
    if (url.endsWith(`/git/commits/${CURRENT_CANDIDATE}`)) {
      return response({
        sha: CURRENT_CANDIDATE,
        tree: { sha: CURRENT_TREE },
        parents: [{ sha: currentParentSha }],
      });
    }
    if (
      url.includes(
        "/actions/workflows/recover-permanent-staging-cold-zero.yml/runs?",
      )
    ) {
      const workflowRuns = [
          PREPARE_RUN,
          AMBIGUOUS_QUIESCE_RUN,
          READ_ONLY_RECONCILE_RUN,
          ...(options.omitIntermediatePrepare
            ? []
            : [INTERMEDIATE_AMBIGUOUS_PREPARE_RUN]),
          ...(options.omitIntermediateReconcile
            ? []
            : [INTERMEDIATE_READ_ONLY_PREPARE_RECONCILE_RUN]),
          ...(options.omitImmediatePriorPrepare
            ? []
            : [IMMEDIATE_PRIOR_PREPARE_RUN]),
          ...(options.omitImmediatePriorQuiesce
            ? []
            : [IMMEDIATE_PRIOR_QUIESCE_RUN]),
          ...(options.omitFailedPrewritePrepare
            ? []
            : [FAILED_PREWRITE_PREPARE_RUN]),
          ...(options.omitFailedPrewriteQuiesce
            ? []
            : [FAILED_PREWRITE_QUIESCE_RUN]),
          CURRENT_PREPARE_RUN,
          options.currentHistoryUpdatedAt
            ? { ...currentRun, updated_at: options.currentHistoryUpdatedAt }
            : currentRun,
          ...(options.extraRuns ?? []),
        ];
      return response({
        total_count: workflowRuns.length,
        workflow_runs: workflowRuns,
      });
    }
    if (
      url.includes(`/actions/runs/${AMBIGUOUS_QUIESCE_RUN_ID}/jobs?`)
    ) {
      return response(coldJobs(
        AMBIGUOUS_QUIESCE_RUN_ID,
        options.ambiguousUsesCurrentNames
          ? CURRENT_COLD_JOB_NAMES
          : LEGACY_COLD_JOB_NAMES,
        options.ambiguousUsesCurrentNames
          ? CURRENT_QUIESCE_JOB_NAME
          : LEGACY_QUIESCE_JOB_NAME,
        "failure",
        [{
          name: options.ambiguousUsesCurrentNames
            ? CURRENT_QUIESCE_WRITE_STEP
            : LEGACY_QUIESCE_WRITE_STEP,
          status: "completed",
          conclusion: "failure",
        }],
      ));
    }
    if (
      url.includes(`/actions/runs/${READ_ONLY_RECONCILE_RUN_ID}/jobs?`)
    ) {
      return response(coldJobs(
        READ_ONLY_RECONCILE_RUN_ID,
        LEGACY_COLD_JOB_NAMES,
        "Reconcile an ambiguous cold quiesce at exact zero",
        "failure",
        [],
      ));
    }
    if (url.includes(`/actions/runs/${CURRENT_PREPARE_RUN_ID}/jobs?`)) {
      const jobNames = options.currentPrepareUsesLegacyNames
        ? LEGACY_COLD_JOB_NAMES
        : CURRENT_COLD_JOB_NAMES;
      return response(coldJobs(
        CURRENT_PREPARE_RUN_ID,
        jobNames,
        "Bind the exact replacement and prepare the dead baseline",
        "success",
        [{
          name: "Prepare the exact dead staging baseline once",
          status: "completed",
          conclusion: "success",
        }],
      ));
    }
    if (url.includes(`/actions/runs/${IMMEDIATE_PRIOR_PREPARE_RUN_ID}/jobs?`)) {
      return response(coldJobs(
        IMMEDIATE_PRIOR_PREPARE_RUN_ID,
        CURRENT_COLD_JOB_NAMES,
        "Bind the exact replacement and prepare the dead baseline",
        "success",
        [{
          name: "Prepare the exact dead staging baseline once",
          status: "completed",
          conclusion: "success",
        }],
      ));
    }
    if (url.includes(`/actions/runs/${FAILED_PREWRITE_PREPARE_RUN_ID}/jobs?`)) {
      return response(coldJobs(
        FAILED_PREWRITE_PREPARE_RUN_ID,
        CURRENT_COLD_JOB_NAMES,
        "Bind the exact replacement and prepare the dead baseline",
        "success",
        [{
          name: "Prepare the exact dead staging baseline once",
          status: "completed",
          conclusion: "success",
        }],
      ));
    }
    if (url.includes(`/actions/runs/${FAILED_PREWRITE_QUIESCE_RUN_ID}/jobs?`)) {
      return response(coldJobs(
        FAILED_PREWRITE_QUIESCE_RUN_ID,
        CURRENT_COLD_JOB_NAMES,
        CURRENT_QUIESCE_JOB_NAME,
        "failure",
        [{
          name: CURRENT_QUIESCE_WRITE_STEP,
          status: "completed",
          conclusion: options.failedPrewriteWriteConclusion ?? "skipped",
        }],
      ));
    }
    if (
      url.includes(`/actions/runs/${INTERMEDIATE_AMBIGUOUS_PREPARE_RUN_ID}/jobs?`)
    ) {
      return response(coldJobs(
        INTERMEDIATE_AMBIGUOUS_PREPARE_RUN_ID,
        CURRENT_COLD_JOB_NAMES,
        "Bind the exact replacement and prepare the dead baseline",
        "failure",
        [{
          name: "Prepare the exact dead staging baseline once",
          status: "completed",
          conclusion: options.intermediatePrepareWriteConclusion ?? "failure",
        }],
      ));
    }
    if (
      url.includes(
        `/actions/runs/${INTERMEDIATE_READ_ONLY_PREPARE_RECONCILE_RUN_ID}/jobs?`,
      )
    ) {
      const listing = coldJobs(
        INTERMEDIATE_READ_ONLY_PREPARE_RECONCILE_RUN_ID,
        CURRENT_COLD_JOB_NAMES,
        "Reconcile an ambiguous cold prepare at the exact dead baseline",
        "failure",
        [],
      );
      if (options.intermediateReconcileSiblingConclusion === "success") {
        listing.jobs.find((job) =>
          job.name === "Bind the exact replacement and prepare the dead baseline"
        )!.conclusion = "success";
      }
      return response(listing);
    }
    if (
      url.includes(`/actions/runs/${AMBIGUOUS_QUIESCE_RUN_ID}/artifacts?`)
    ) {
      return response({
        total_count: 1,
        artifacts: [{
          id: ARTIFACT_ID,
          name: ARTIFACT_NAME,
          size_in_bytes: 4507,
          digest: artifactDigest,
          expired: false,
          created_at: "2026-09-07T18:57:18Z",
          updated_at: "2026-09-07T18:57:18Z",
          expires_at: "2026-10-07T18:57:18Z",
          workflow_run: {
            id: AMBIGUOUS_QUIESCE_RUN_ID,
            head_branch: "main",
            head_sha: PRIOR_CANDIDATE,
          },
        }],
      });
    }
    if (
      url.includes(`/actions/runs/${IMMEDIATE_PRIOR_QUIESCE_RUN_ID}/artifacts?`)
    ) {
      return response({
        total_count: 1,
        artifacts: [{
          id: IMMEDIATE_PRIOR_ARTIFACT_ID,
          name: IMMEDIATE_PRIOR_ARTIFACT_NAME,
          size_in_bytes: 8155,
          digest: options.immediatePriorArtifactDigest ??
            IMMEDIATE_PRIOR_ARTIFACT_DIGEST,
          expired: false,
          created_at: "2026-09-08T04:32:24Z",
          updated_at: "2026-09-08T04:32:24Z",
          expires_at: "2026-10-08T04:32:22Z",
          workflow_run: {
            id: IMMEDIATE_PRIOR_QUIESCE_RUN_ID,
            head_branch: "main",
            head_sha: IMMEDIATE_PRIOR_CANDIDATE,
          },
        }],
      });
    }
    if (
      url.includes(`/actions/runs/${FAILED_PREWRITE_QUIESCE_RUN_ID}/artifacts?`)
    ) {
      return response({
        total_count: 1,
        artifacts: [{
          id: FAILED_PREWRITE_ARTIFACT_ID,
          name: FAILED_PREWRITE_ARTIFACT_NAME,
          size_in_bytes: 2920,
          digest: options.failedPrewriteArtifactDigest ??
            FAILED_PREWRITE_ARTIFACT_DIGEST,
          expired: false,
          created_at: "2026-09-08T11:44:03Z",
          updated_at: "2026-09-08T11:44:03Z",
          expires_at: "2026-10-08T11:44:02Z",
          workflow_run: {
            id: FAILED_PREWRITE_QUIESCE_RUN_ID,
            head_branch: "main",
            head_sha: FAILED_PREWRITE_CANDIDATE,
          },
        }],
      });
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  });

  return {
    fetchImpl,
    verify: () => verifyColdQuiesceSuccessorBridge(
      {
        fetchImpl,
        token: "github-metadata-token",
        candidateSha: CURRENT_CANDIDATE,
        priorCandidateSha: options.inputPriorCandidateSha ??
          IMMEDIATE_PRIOR_CANDIDATE,
        priorRunId: options.inputPriorRunId ??
          String(IMMEDIATE_PRIOR_QUIESCE_RUN_ID),
        failedPrewriteCandidateSha: FAILED_PREWRITE_CANDIDATE,
        failedPrewriteRunId: String(FAILED_PREWRITE_QUIESCE_RUN_ID),
        prepareRunId: String(CURRENT_PREPARE_RUN_ID),
        currentMergedAtMs: Date.parse(
          options.currentMergedAt ?? CURRENT_MERGED_AT,
        ),
      },
      { repository: REPOSITORY, branch: "main" },
      { treeSha: CURRENT_TREE },
      {
        ...currentRun,
        run_started_at: currentRunStartedAt,
        startedAt: Date.parse(currentRunStartedAt),
      },
    ),
  };
}

describe("GitHub-reviewed cold-quiesce successor bridge", () => {
  it("binds the reviewed five-candidate successor to the exact eleven-run history", async () => {
    const fixture = bridgeFixture();

    await expect(fixture.verify()).resolves.toMatchObject({
      priorAmbiguousColdQuiesceCandidateSha: IMMEDIATE_PRIOR_CANDIDATE,
      priorAmbiguousColdQuiesceRunId: String(IMMEDIATE_PRIOR_QUIESCE_RUN_ID),
      priorAmbiguousColdQuiesceRunCompletedAt:
        "2026-09-08T04:32:27.000Z",
      coldQuiesceSuccessorGraceHours: 24,
      coldQuiesceSuccessorDeadline: "2026-09-08T18:57:20.000Z",
      coldQuiesceSuccessorWithinGraceExact: true,
      priorColdPrepareRunId: String(IMMEDIATE_PRIOR_PREPARE_RUN_ID),
      selectedColdPrepareRunId: String(CURRENT_PREPARE_RUN_ID),
      selectedColdPrepareRunStartedAt: "2026-09-08T12:02:00.000Z",
      selectedColdPrepareRunCompletedAt: "2026-09-08T12:07:00.000Z",
      legacyColdRecoveryCandidateSha: PRIOR_CANDIDATE,
      legacyColdPrepareRunId: String(PREPARE_RUN_ID),
      legacyColdQuiesceRunId: String(AMBIGUOUS_QUIESCE_RUN_ID),
      legacyFailedReadOnlyColdQuiesceReconcileRunId:
        String(READ_ONLY_RECONCILE_RUN_ID),
      intermediateColdRecoveryCandidateSha: INTERMEDIATE_CANDIDATE,
      intermediateColdRecoveryReviewedHeadSha: INTERMEDIATE_REVIEWED_HEAD,
      intermediateColdRecoveryTreeSha: INTERMEDIATE_TREE,
      intermediateColdRecoveryPullRequestNumber: 91,
      intermediateColdRecoveryCandidateMergedAt: "2026-09-08T02:22:51Z",
      intermediateAmbiguousColdPrepareRunId:
        String(INTERMEDIATE_AMBIGUOUS_PREPARE_RUN_ID),
      intermediateFailedReadOnlyColdPrepareReconcileRunId:
        String(INTERMEDIATE_READ_ONLY_PREPARE_RECONCILE_RUN_ID),
      priorAmbiguousColdQuiesceArtifactId:
        String(IMMEDIATE_PRIOR_ARTIFACT_ID),
      priorAmbiguousColdQuiesceArtifactDigest:
        IMMEDIATE_PRIOR_ARTIFACT_DIGEST,
      failedPrewriteColdRecoveryCandidateSha: FAILED_PREWRITE_CANDIDATE,
      failedPrewriteColdPrepareRunId: String(FAILED_PREWRITE_PREPARE_RUN_ID),
      failedPrewriteColdQuiesceRunId: String(FAILED_PREWRITE_QUIESCE_RUN_ID),
      failedPrewriteColdQuiesceArtifactId:
        String(FAILED_PREWRITE_ARTIFACT_ID),
      failedPrewriteColdQuiesceArtifactDigest:
        FAILED_PREWRITE_ARTIFACT_DIGEST,
      legacyAmbiguousColdQuiesceArtifactId: String(ARTIFACT_ID),
      legacyAmbiguousColdQuiesceArtifactDigest: ARTIFACT_DIGEST,
      coldQuiesceSuccessorDirectParentExact: true,
      coldQuiesceSuccessorLegacyToIntermediateParentExact: true,
      coldQuiesceSuccessorIntermediateToPriorParentExact: true,
      coldQuiesceSuccessorPriorToFailedPrewriteParentExact: true,
      coldQuiesceSuccessorCompleteFiveCandidateLineageExact: true,
      coldQuiesceSuccessorLegacyHistoryExact: true,
      coldQuiesceSuccessorIntermediateHistoryExact: true,
      coldQuiesceSuccessorPriorHistoryExact: true,
      coldQuiesceSuccessorFailedPrewriteHistoryExact: true,
      coldQuiesceSuccessorFailedPrewriteSkippedExact: true,
      coldQuiesceSuccessorAllRefsHistoryExact: true,
      coldQuiesceSuccessorCurrentPrepareExact: true,
      coldQuiesceSuccessorLegacyArtifactMetadataExact: true,
      coldQuiesceSuccessorPriorArtifactMetadataExact: true,
      coldQuiesceSuccessorFailedPrewriteArtifactMetadataExact: true,
      coldQuiesceSuccessorPriorProviderProofRequired: true,
      coldQuiesceSuccessorBridgeRequired: true,
    });
    const historyUrl = String(fixture.fetchImpl.mock.calls.find(([request]) =>
      String(request).includes("/actions/workflows/") &&
      String(request).includes("/runs?"))?.[0]);
    expect(historyUrl).not.toContain("branch=");
    expect(historyUrl).not.toContain("created=");
  });

  it("rejects the legacy candidate and run as public prior inputs", async () => {
    await expect(bridgeFixture({
      inputPriorCandidateSha: PRIOR_CANDIDATE,
      inputPriorRunId: String(AMBIGUOUS_QUIESCE_RUN_ID),
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_invalid",
    );
  });

  it("pins legacy quiesce job and write names only to run 34153306935", async () => {
    await expect(bridgeFixture({
      ambiguousUsesCurrentNames: true,
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_history_invalid",
    );
    await expect(bridgeFixture({
      currentPrepareUsesLegacyNames: true,
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_history_invalid",
    );
  });

  it("accepts an advanced mutable updated_at for the current nonterminal run", async () => {
    await expect(bridgeFixture({
      currentHistoryUpdatedAt: "2026-09-08T12:10:05Z",
    }).verify()).resolves.toMatchObject({
      coldQuiesceSuccessorAllRefsHistoryExact: true,
    });
  });

  it.each([
    ["overlapping unknown ref", coldRun({
      id: 34150000000,
      operation: "quiesce",
      createdAt: "2026-09-07T18:00:00Z",
      completedAt: "2026-09-07T18:20:00Z",
      conclusion: "failure",
      headSha: "c".repeat(40),
    })],
    ["unknown nonterminal run", coldRun({
      id: 34150000001,
      operation: "quiesce",
      createdAt: "2026-09-01T00:00:00Z",
      completedAt: "2026-09-01T00:00:00Z",
      conclusion: null,
      status: "in_progress",
      headSha: "d".repeat(40),
    })],
    ["unknown future run status", coldRun({
      id: 34150000002,
      operation: "quiesce",
      createdAt: "2026-09-01T00:00:00Z",
      completedAt: "2026-09-01T00:00:00Z",
      conclusion: null,
      status: "future_status",
      headSha: "e".repeat(40),
    })],
  ])("fails closed on %s from complete all-ref history", async (_label, extra) => {
    await expect(bridgeFixture({ extraRuns: [extra] }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_history_invalid",
    );
  });

  it.each([
    ["prepare", { omitImmediatePriorPrepare: true }],
    ["quiesce", { omitImmediatePriorQuiesce: true }],
  ])("fails closed when the immediate-prior %s run is absent", async (
    _label,
    options,
  ) => {
    await expect(bridgeFixture(options).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_history_invalid",
    );
  });

  it("fails closed when the current candidate is not the direct child", async () => {
    const fixture = bridgeFixture({ currentParentSha: "3".repeat(40) });

    await expect(fixture.verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_invalid",
    );
  });

  it("fails closed when the failed-prewrite candidate is not the immediate-prior child", async () => {
    await expect(bridgeFixture({
      failedPrewriteParentSha: "3".repeat(40),
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_invalid",
    );
  });

  it("fails closed when the immediate prior is not the intermediate direct child", async () => {
    const fixture = bridgeFixture({
      immediatePriorParentSha: "3".repeat(40),
    });

    await expect(fixture.verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_invalid",
    );
  });

  it("fails closed when the intermediate candidate is not the legacy direct child", async () => {
    const fixture = bridgeFixture({ intermediateParentSha: "3".repeat(40) });

    await expect(fixture.verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_invalid",
    );
  });

  it.each([
    ["ambiguous prepare", { omitIntermediatePrepare: true }],
    ["read-only prepare reconciliation", { omitIntermediateReconcile: true }],
  ])("fails closed when the pinned intermediate %s run is absent", async (
    _label,
    options,
  ) => {
    await expect(bridgeFixture(options).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_history_invalid",
    );
  });

  it("requires the intermediate prepare to be conservatively may-have-written", async () => {
    await expect(bridgeFixture({
      intermediatePrepareWriteConclusion: "skipped",
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_history_invalid",
    );
  });

  it.each(["success", "failure", "cancelled"] as const)(
    "requires the failed-prewrite writer step to be completed/skipped, not %s",
    async (conclusion) => {
      await expect(bridgeFixture({
        failedPrewriteWriteConclusion: conclusion,
      }).verify()).rejects.toThrow(
        "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_history_invalid",
      );
    },
  );

  it("requires every sibling of the failed read-only reconciliation to be skipped", async () => {
    await expect(bridgeFixture({
      intermediateReconcileSiblingConclusion: "success",
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_history_invalid",
    );
  });

  it("fails closed when the current review overlaps the immediate-prior quiesce", async () => {
    await expect(bridgeFixture({
      currentMergedAt: "2026-09-08T04:32:26Z",
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_history_invalid",
    );
  });

  it("fails closed when the legacy artifact digest is substituted", async () => {
    const fixture = bridgeFixture({
      artifactDigest: `sha256:${"4".repeat(64)}`,
    });

    await expect(fixture.verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_artifact_invalid",
    );
  });

  it("fails closed when the immediate-prior artifact digest is substituted", async () => {
    const fixture = bridgeFixture({
      immediatePriorArtifactDigest: `sha256:${"4".repeat(64)}`,
    });

    await expect(fixture.verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_artifact_invalid",
    );
  });

  it("fails closed when the failed-prewrite artifact digest is substituted", async () => {
    await expect(bridgeFixture({
      failedPrewriteArtifactDigest: `sha256:${"4".repeat(64)}`,
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_artifact_invalid",
    );
  });

  it("fails closed at the pinned successor deadline", async () => {
    const fixture = bridgeFixture({
      currentRunStartedAt: "2026-09-08T18:57:20.000Z",
    });

    await expect(fixture.verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_history_invalid",
    );
  });
});
